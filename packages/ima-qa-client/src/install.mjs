import { cp, mkdir, readdir, readFile, rename, rm, lstat } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { atomic, optionalJson, json, digest, lock, fault, defaultConfig } from './config.mjs';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultInstallDir = () => join(homedir(), '.local/share/ima-qa');
export async function fingerprint(dir) {
  const entries = [];
  async function walk(path, relative = '') {
    for (const name of (await readdir(path)).sort()) {
      if (name === 'node_modules') continue;
      const full = join(path, name), key = `${relative}/${name}`, stat = await lstat(full);
      if (stat.isSymbolicLink()) throw fault('managed_symlink_conflict');
      if (stat.isDirectory()) await walk(full, key);
      else entries.push([key, digest(await readFile(full))]);
    }
  }
  await walk(dir);
  return digest(JSON.stringify(entries));
}
function codex(args) {
  try { return execFileSync('codex', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw fault(error.code === 'ENOENT' ? 'codex_not_found' : 'codex_command_failed'); }
}
function registrations(run) {
  const value = JSON.parse(run(['mcp', 'list', '--json']));
  if (!Array.isArray(value)) throw fault('invalid_codex_response');
  return value;
}
function matches(entry, registration) {
  const t = entry?.transport;
  return t?.command === registration?.command && JSON.stringify(t?.args) === JSON.stringify(registration?.args) &&
    !Object.keys(t?.env || {}).length && !t?.cwd;
}
function add(run, reg) { run(['mcp', 'add', 'ima-qa', '--', reg.command, ...reg.args]); }
export async function setup(options = {}, { runCodex = codex, source = packageRoot } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw fault('node_22_required');
  if (options.agent && options.agent !== 'codex') throw fault('unsupported_agent');
  const root = resolve(options.installDir || defaultInstallDir());
  const relation = relative(source, root);
  if (!relation || (!relation.startsWith('..') && !isAbsolute(relation))) throw fault('install_inside_source');
  const configFile = resolve(options.config || defaultConfig());
  const profile = options.profile || 'default';
  return lock(`${root}.lock`, async () => {
    const receiptFile = join(root, 'installation.json');
    const old = await optionalJson(receiptFile);
    const skillTarget = resolve(options.skillsDir || join(homedir(), '.agents/skills'), 'ima-qa');
    if (old && (old.skillTarget !== skillTarget || old.configFile !== configFile)) throw fault('installation_target_conflict');
    const registry = registrations(runCodex); // Missing Codex must not be reported as successful registration.
    const existing = registry.find(x => x.name === 'ima-qa');
    if (existing && (!old || !matches(existing, old.registration))) throw fault('mcp_name_conflict');
    if (old && await fingerprint(old.installPath) !== old.clientHash) throw fault('modified_client_conflict');
    try {
      const currentHash = await fingerprint(skillTarget);
      if (!old || currentHash !== old.skillHash) throw fault('modified_skill_conflict');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Scan by frontmatter name too: an earlier installation may use a different directory.
    for (const directory of new Set([dirname(skillTarget), join(homedir(), '.agents/skills'),
      join(homedir(), '.codex/skills'), join(process.cwd(), '.agents/skills')])) {
      let names;
      try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const name of names) {
        const candidate = join(directory, name);
        if (resolve(candidate) === skillTarget) continue;
        let content;
        try { content = await readFile(join(candidate, 'SKILL.md'), 'utf8'); }
        catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
        if (/^name:\s*["']?ima-qa["']?\s*$/m.test(content)) throw fault('duplicate_skill_conflict', { path: candidate });
      }
    }
    let config = await optionalJson(configFile);
    if (!config?.profiles?.[profile]) {
      if (!options.baseUrl || !options.scopeRef || !options.applicationId) throw fault('setup_profile_required');
      config ||= { profiles: {} };
      config.profiles ||= {};
      config.profiles[profile] = { baseUrl: options.baseUrl, applicationId: options.applicationId,
        clientId: `ima-agent-${randomUUID()}`, knowledgeScopeRef: options.scopeRef,
        knowledgeBaseName: options.knowledgeBaseName || '', apiTokenEnv: 'IMA_QA_API_TOKEN', internalServiceTokenEnv: 'IMA_QA_INTERNAL_TOKEN' };
      await atomic(configFile, config);
    }
    const manifest = await json(join(source, 'package.json'));
    const clientHash = await fingerprint(source);
    const installPath = join(root, 'versions', `${manifest.version}-${clientHash.slice(0, 12)}`);
    const staging = join(root, `stage-${randomUUID()}`);
    const skillStage = join(root, `skill-stage-${randomUUID()}`);
    const backup = join(root, `skill-backup-${randomUUID()}`); // Outside skill discovery.
    let replaced = false, registered = false;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      try { await lstat(installPath); if (await fingerprint(installPath) !== clientHash) throw fault('modified_client_conflict'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await cp(source, staging, { recursive: true, verbatimSymlinks: true });
        // Verify dependencies before making the installation visible.
        execFileSync(process.execPath, ['--input-type=module', '-e', "await import('@modelcontextprotocol/sdk/server/mcp.js')"], { cwd: staging, stdio: 'pipe' });
        await mkdir(dirname(installPath), { recursive: true });
        await rename(staging, installPath);
      }
      const registration = { command: process.execPath, args: [join(installPath, 'bin/ima-qa.mjs'), 'mcp', '--config', configFile, '--profile', profile] };
      await mkdir(dirname(skillTarget), { recursive: true });
      // Stage under managed root; a staging SKILL.md must never appear in discovery.
      await cp(join(source, 'skills/ima-qa'), skillStage, { recursive: true });
      registered = true; add(runCodex, registration);
      if (!matches(registrations(runCodex).find(x => x.name === 'ima-qa'), registration)) throw fault('mcp_registration_unverified');
      try { await rename(skillTarget, backup); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(skillStage, skillTarget); replaced = true;
      const receipt = { schemaVersion: 1, version: manifest.version, installPath, clientHash, skillTarget,
        skillHash: await fingerprint(skillTarget), configFile, profile, registration };
      await atomic(receiptFile, receipt);
      await rm(backup, { recursive: true, force: true });
      return { installed: true, version: manifest.version, skill: 'ima 知识库助手', skillPath: skillTarget,
        cli: join(installPath, 'bin/ima-qa.mjs'), configFile, mcpRegistered: true, readiness: 'Run doctor with configured credentials; restart Codex if skill discovery has not refreshed.' };
    } catch (error) {
      if (replaced) await rm(skillTarget, { recursive: true, force: true });
      try { await rename(backup, skillTarget); } catch (restore) { if (restore.code !== 'ENOENT') throw fault('skill_rollback_failed'); }
      if (registered) {
        try { if (existing) add(runCodex, old.registration); else runCodex(['mcp', 'remove', 'ima-qa']); }
        catch { throw fault('mcp_rollback_failed'); }
      }
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(skillStage, { recursive: true, force: true });
    }
  });
}
export async function uninstall(options = {}, { runCodex = codex } = {}) {
  const root = resolve(options.installDir || defaultInstallDir());
  return lock(`${root}.lock`, async () => {
    const path = join(root, 'installation.json');
    const receipt = await optionalJson(path);
    if (!receipt) return { removed: false };
    if (await fingerprint(receipt.skillTarget) !== receipt.skillHash) throw fault('modified_skill_conflict');
    const existing = registrations(runCodex).find(x => x.name === 'ima-qa');
    if (existing && !matches(existing, receipt.registration)) throw fault('mcp_name_conflict');
    if (existing) runCodex(['mcp', 'remove', 'ima-qa']);
    await rm(receipt.skillTarget, { recursive: true });
    await rm(path);
    return { removed: true, retained: 'Provider, private config, task archives and version directories are preserved.' };
  });
}
