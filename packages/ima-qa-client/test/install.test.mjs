import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, uninstall, fingerprint, packageRoot } from '../src/install.mjs';
import { atomic } from '../src/config.mjs';

test('installer registers one Chinese skill, repeats, rolls back, protects edits and uninstalls only owned resources', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ima-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { installDir: join(dir, 'managed'), skillsDir: join(dir, 'skills'), config: join(dir, 'private/client.json'), agent: 'codex' };
  await atomic(options.config, { profiles: { default: {} } });
  let registry = [], breakVerify = false;
  const runCodex = args => {
    if (args[1] === 'list') {
      if (breakVerify && registry.length) { breakVerify = false; throw Error('verification failure'); }
      return JSON.stringify(registry);
    }
    if (args[1] === 'add') { registry = [{ name: 'ima-qa', transport: { type: 'stdio', command: args[4], args: args.slice(5) } }]; return ''; }
    if (args[1] === 'remove') { registry = []; return ''; }
    throw Error('unexpected command');
  };
  const first = await setup(options, { runCodex });
  assert.equal(first.skill, 'ima 知识库助手'); assert.equal(registry.length, 1);
  assert.deepEqual(await readdir(options.skillsDir), ['ima-qa']);
  const original = await readFile(join(first.skillPath, 'SKILL.md'), 'utf8');
  await setup(options, { runCodex }); assert.equal(registry.length, 1);
  // Fail after a successful registration, not in the initial preflight.
  let lists = 0;
  await assert.rejects(setup(options, { runCodex: args => { if (args[1] === 'list' && ++lists === 2) throw Error('verify failed'); return runCodex(args); } }));
  assert.equal(await readFile(join(first.skillPath, 'SKILL.md'), 'utf8'), original);
  assert.equal(registry.length, 1);
  await writeFile(join(first.skillPath, 'SKILL.md'), original + '\nlocal edit');
  await assert.rejects(setup(options, { runCodex }), { code: 'modified_skill_conflict' });
  await assert.rejects(uninstall(options, { runCodex }), { code: 'modified_skill_conflict' });
  await writeFile(join(first.skillPath, 'SKILL.md'), original);
  assert.equal((await uninstall(options, { runCodex })).removed, true);
  assert.equal(registry.length, 0);
  assert.ok(await readFile(options.config));
  assert.equal((await uninstall(options, { runCodex })).removed, false);
});

test('post-commit backup cleanup failure preserves the new receipt, Skill and MCP and permits retry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ima-install-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { installDir: join(dir, 'managed'), skillsDir: join(dir, 'skills'), config: join(dir, 'private/client.json'), agent: 'codex' };
  await atomic(options.config, { profiles: { default: {} } });
  let registry = [];
  const runCodex = args => {
    if (args[1] === 'list') return JSON.stringify(registry);
    if (args[1] === 'add') { registry = [{ name: 'ima-qa', transport: { type: 'stdio', command: args[4], args: args.slice(5) } }]; return ''; }
    if (args[1] === 'remove') { registry = []; return ''; }
    throw Error('unexpected command');
  };
  await setup(options, { runCodex });
  const receiptPath = join(options.installDir, 'installation.json');
  const before = JSON.parse(await readFile(receiptPath, 'utf8'));
  const source = join(dir, 'updated-client');
  await cp(packageRoot, source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await atomic(join(source, 'package.json'), { ...manifest, version: '0.1.1' });
  await writeFile(join(source, 'skills/ima-qa/SKILL.md'), (await readFile(join(source, 'skills/ima-qa/SKILL.md'), 'utf8')) + '\nUpgrade fixture.\n');
  let cleanups = 0;
  const upgraded = await setup(options, { runCodex, source, cleanupBackup: async () => {
    cleanups++; throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EACCES' });
  } });
  assert.equal(cleanups, 1);
  assert.equal(upgraded.installed, true);
  assert.equal(upgraded.warning, 'backup_cleanup_failed');
  const current = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(current.version, '0.1.1');
  assert.notEqual(current.clientHash, before.clientHash);
  assert.notEqual(current.skillHash, before.skillHash);
  assert.equal(await fingerprint(current.skillTarget), current.skillHash);
  assert.equal(await fingerprint(current.installPath), current.clientHash);
  assert.equal(registry[0].transport.command, current.registration.command);
  assert.deepEqual(registry[0].transport.args, current.registration.args);
  assert.deepEqual(await readdir(options.skillsDir), ['ima-qa']);
  assert.ok((await readdir(options.installDir)).some(name => name.startsWith('skill-backup-')));
  assert.equal((await setup(options, { runCodex, source })).installed, true);
  assert.equal((await uninstall(options, { runCodex })).removed, true);
});
