const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');
const { chromium } = require('playwright-core');
const { buildProviderAEnv, createSecret } = require('./provider-a-release');
const { resolveSharedTargetWithLogin, parseShareUrl } = require('./shared-kb-target');

const fail = code => Object.assign(new Error(code), { code });
function parseOptions(args) {
  const options = {};
  const names = new Set(['share-url', 'target-file', 'env', 'project', 'port', 'mode', 'image', 'name', 'server-url', 'ssh', 'remote-env', 'remote-port', 'local-port', 'directory']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !names.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw fail('invalid_arguments');
    const name = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (Object.hasOwn(options, name)) throw fail('invalid_arguments');
    options[name] = args[++i];
  }
  return options;
}
function privateWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); }
  catch { throw fail('existing_installation_protected'); }
}
function privateReplace(file, value) {
  const next = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  privateWrite(next, value); fs.renameSync(next, file);
}
async function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env || process.env,
      stdio: options.interactive ? 'inherit' : 'ignore', windowsHide: !options.interactive });
    const timer = setTimeout(() => { child.kill(); reject(fail('command_timeout')); }, options.timeout || 180000);
    child.once('error', () => { clearTimeout(timer); reject(fail('command_unavailable')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(fail(options.code || 'command_failed')); });
  });
}
async function capture(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let text = '';
    const timer = setTimeout(() => { child.kill(); reject(fail('command_timeout')); }, 15000);
    child.stdout.on('data', value => { text += value; if (text.length > 65536) child.kill(); });
    child.once('error', () => { clearTimeout(timer); reject(fail('command_unavailable')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(text.trim()) : reject(fail('command_failed')); });
  });
}
async function portAvailable(value) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(fail('port_unavailable')));
    server.listen(value, '127.0.0.1', () => server.close(resolve));
  });
}
function maintenanceSpec(platform, options) {
  const suffix = crypto.createHash('sha256').update(options.project).digest('hex').slice(0, 12);
  const label = `com.ima.enrollment.${suffix}`;
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const args = [options.node, options.script, options.config];
  if (platform === 'darwin') return { label, document: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(a => `<string>${escape(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer></dict></plist>\n` };
  if (platform === 'win32') {
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    const argumentsText = [options.script, options.config].map(a => `"${a.replaceAll('"', '')}"`).join(' ');
    return { label, document: `$ErrorActionPreference = 'Stop'\n$action = New-ScheduledTaskAction -Execute ${quote(options.node)} -Argument ${quote(argumentsText)}\n$existing = Get-ScheduledTask -TaskName ${quote(label)} -ErrorAction SilentlyContinue\nif ($existing) {\n  if ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $action.Execute -or $existing.Actions[0].Arguments -ne $action.Arguments) { throw 'Foreign helper task; refusing replacement' }\n} else {\n  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)\n  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited\n  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)\n  Register-ScheduledTask -TaskName ${quote(label)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null\n}\nStart-ScheduledTask -TaskName ${quote(label)}\n` };
  }
  throw fail('maintenance_desktop_required');
}
function composeSpec(options) {
  return { services: { 'ima-qa-web': { image: options.image, restart: 'unless-stopped',
    env_file: [options.env], ports: [`127.0.0.1:${options.port}:3000`],
    volumes: ['provider-state:/app/runtime'] } }, volumes: { 'provider-state': {} } };
}
function port(input, fallback) {
  const result = Number(input || fallback);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw fail('invalid_port');
  return result;
}
function projectName(input) {
  const value = input || 'ima-guided';
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(value)) throw fail('invalid_project');
  return value;
}
function envRead(file) {
  try { return dotenv.parse(fs.readFileSync(file)); } catch { throw fail('private_configuration_unavailable'); }
}
async function helperProbe(config) {
  let browser;
  try {
    browser = await chromium.connect(`ws://127.0.0.1:${config.port}/${config.key}`, { timeout: 3000 });
    return true;
  } catch { return false; }
  finally { await browser?.close().catch(() => {}); }
}
async function waitForHelper(config) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await helperProbe(config)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw fail('browser_helper_not_ready_use_repair');
}
function validateHelperState(state, root, directory, platform = process.platform) {
  const config = path.join(directory, 'browser.json');
  const spec = maintenanceSpec(platform, { project: projectName(state.project), node: process.execPath,
    script: path.join(root, 'scripts/enrollment-browser-helper.mjs'), config });
  const definition = platform === 'darwin' ? path.join(os.homedir(), 'Library/LaunchAgents', `${spec.label}.plist`)
    : path.join(directory, 'register-helper.ps1');
  if (state.root !== root || state.platform !== platform || state.config !== config
    || state.definition !== definition || state.label !== spec.label || state.document !== spec.document
    || state.playwrightVersion !== require('playwright-core/package.json').version
    || !/^[a-f0-9]{64}$/.test(state.configuration?.key || '')
    || !Number.isInteger(state.configuration?.port) || state.configuration.port < 1 || state.configuration.port > 65535) {
    throw fail('helper_version_or_owner_mismatch');
  }
  for (const [file, content] of [[config, JSON.stringify(state.configuration)], [definition, spec.document]]) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content) throw fail('existing_helper_protected');
  }
}
async function configureBrowser(root, options, emit) {
  if (!['darwin', 'win32'].includes(process.platform)) throw fail('maintenance_desktop_required');
  const directory = path.resolve(options.directory || path.join(root, '.onboarding'));
  const statePath = path.join(directory, 'helper-state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    validateHelperState(state, root, directory);
    finishHelperFiles(state);
    const config = JSON.parse(fs.readFileSync(state.config, 'utf8'));
    if (!await helperProbe(config)) await startHelper(state);
    await waitForHelper(config);
    emit({ stage: 'browser_ready', configured: true, ready: true });
    return state;
  }
  await run(process.execPath, [path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js'), 'install', 'chromium'], { cwd: root, timeout: 300000, code: 'browser_download_failed' });
  const browserPath = chromium.executablePath();
  if (!fs.existsSync(browserPath)) throw fail('browser_unavailable');
  const server = await chromium.launchServer({ headless: true, port: 0, host: '127.0.0.1', executablePath: browserPath });
  const helperPort = Number(new URL(server.wsEndpoint()).port);
  await server.close();
  const configPath = path.join(directory, 'browser.json');
  const configuration = { browserPath, port: helperPort, key: crypto.randomBytes(32).toString('hex') };
  const spec = maintenanceSpec(process.platform, { project: projectName(options.project), node: process.execPath,
    script: path.join(root, 'scripts/enrollment-browser-helper.mjs'), config: configPath });
  const definition = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/LaunchAgents', `${spec.label}.plist`)
    : path.join(directory, 'register-helper.ps1');
  if (fs.existsSync(definition) || fs.existsSync(configPath)) throw fail('existing_helper_protected');
  const state = { schemaVersion: 1, root, project: projectName(options.project), config: configPath, definition, label: spec.label,
    platform: process.platform, playwrightVersion: require('playwright-core/package.json').version,
    configuration, document: spec.document };
  // Reserve ownership before creating files, so an interrupted install is resumable.
  privateWrite(statePath, JSON.stringify(state));
  finishHelperFiles(state);
  try {
    await startHelper(state);
    await waitForHelper(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch { throw fail('browser_helper_not_ready_use_repair'); }
  emit({ stage: 'browser_ready', configured: true, ready: true });
  return state;
}
function finishHelperFiles(state) {
  for (const [file, content] of [[state.config, JSON.stringify(state.configuration)], [state.definition, state.document]]) {
    if (typeof content !== 'string') throw fail('helper_state_invalid');
    if (!fs.existsSync(file)) privateWrite(file, content);
    else if (fs.readFileSync(file, 'utf8') !== content) throw fail('existing_helper_protected');
  }
}
async function startHelper(state) {
  if (state.platform === 'darwin') {
    await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, state.definition]).catch(async () => {
      await run('launchctl', ['kickstart', `gui/${process.getuid()}/${state.label}`]);
    });
  } else await run('powershell.exe', ['-NoProfile', '-File', state.definition]);
}
async function resolveGuidedTarget(root, options, emit, dependencies = {}) {
  const fetchImpl = dependencies.fetch || fetch;
  if (options.targetFile && fs.existsSync(path.resolve(options.targetFile))) {
    const text = fs.readFileSync(path.resolve(options.targetFile), 'utf8');
    if (text.length > 4096) throw fail('target_manifest_invalid');
    const saved = JSON.parse(text);
    if (saved.schemaVersion !== 1 || saved.shareUrl !== parseShareUrl(options.shareUrl).url
      || !/^[1-9][0-9]{0,29}$/.test(saved.knowledgeBaseId || '') || typeof saved.name !== 'string') throw fail('target_manifest_invalid');
    return { shareUrl: saved.shareUrl, knowledgeBaseId: saved.knowledgeBaseId, name: saved.name.slice(0, 160) };
  }
  const desktop = (options.mode || (process.platform === 'linux' ? 'server' : 'desktop')) === 'desktop';
  const openOfficial = dependencies.openOfficial || (desktop ? async url => {
    const state = await configureBrowser(root, options, emit);
    const config = JSON.parse(fs.readFileSync(state.config, 'utf8'));
    const browser = await chromium.connect(`ws://127.0.0.1:${config.port}/${config.key}`, { timeout: 5000 });
    let context;
    const close = async () => {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      await context?.close().catch(() => {}); await browser.close().catch(() => {});
    };
    const stop = async () => { await close(); process.exit(130); };
    try {
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.bringToFront();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      return { captureAuth: () => require('./web-agent-enrollment').captureAuthFromContext(context), close };
    } catch { await close(); throw fail('share_login_window_unavailable'); }
  } : undefined);
  const target = await resolveSharedTargetWithLogin(options.shareUrl, { fetchImpl, openOfficial, emit });
  if (options.targetFile) privateWrite(path.resolve(options.targetFile), JSON.stringify({ schemaVersion: 1,
    shareUrl: target.shareUrl, knowledgeBaseId: target.knowledgeBaseId, name: target.name || '' }));
  return target;
}
async function guided(root, command, options, emit = value => console.log(JSON.stringify(value)), dependencies = {}) {
  const execute = dependencies.run || run;
  const readCommand = dependencies.capture || capture;
  const fetchImpl = dependencies.fetch || fetch;
  const directory = path.resolve(options.directory || path.join(root, '.onboarding'));
  const statePath = path.join(directory, 'deployment.json');
  const journal = path.join(directory, 'installation-pending.json');
  function finishConfiguration(state) {
    if (state.root !== root || state.schemaVersion !== 1 || state.env !== path.join(directory, 'provider.env') || state.compose !== path.join(directory, 'compose.json')) throw fail('installation_owner_mismatch');
    if (!fs.existsSync(state.env)) {
      let content = buildProviderAEnv({ sharedKnowledgeBaseId: state.target.knowledgeBaseId, hostPort: state.hostPort })
        + `\nIMA_QA_API_TOKEN=${createSecret()}\nIMA_QA_INTERNAL_SERVICE_TOKEN=${createSecret()}\nIMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_SHARE_URL=${state.target.shareUrl}\n`;
      if (state.mode === 'desktop') {
        const helper = JSON.parse(fs.readFileSync(path.join(directory, 'helper-state.json'), 'utf8'));
        if (helper.root !== root) throw fail('helper_owner_mismatch');
        const config = JSON.parse(fs.readFileSync(helper.config, 'utf8'));
        content += `IMA_ENROLLMENT_BROWSER_ENDPOINT=ws://host.docker.internal:${config.port}/${config.key}\nIMA_WEB_AGENT_ENROLLMENT_BROWSER_MODE=visible\n`;
      }
      privateWrite(state.env, content);
    }
    if (envRead(state.env).IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID !== state.target.knowledgeBaseId) throw fail('knowledge_base_mismatch');
    const spec = composeSpec({ image: state.image, env: state.env, port: state.hostPort, project: state.project });
    if (!fs.existsSync(state.compose)) privateWrite(state.compose, JSON.stringify(spec, null, 2));
    else if (JSON.stringify(JSON.parse(fs.readFileSync(state.compose))) !== JSON.stringify(spec)) throw fail('existing_compose_protected');
    if (!fs.existsSync(statePath)) privateWrite(statePath, JSON.stringify(state, null, 2));
    if (fs.existsSync(journal)) fs.unlinkSync(journal);
  }
  if (command === 'resolve') {
    const target = await resolveGuidedTarget(root, options, emit, dependencies);
    emit({ stage: 'target_resolved', ...target }); return target;
  }
  if (command === 'doctor') {
    const docker = await execute('docker', ['info'], { timeout: 10000 }).then(() => true, () => false);
    const compose = await execute('docker', ['compose', 'version'], { timeout: 10000 }).then(() => true, () => false);
    emit({ stage: 'preflight', platform: process.platform, docker, compose,
      maintenanceDesktop: ['darwin', 'win32'].includes(process.platform), existingInstallation: fs.existsSync(statePath),
      nodeVersion: process.version, playwrightVersion: require('playwright-core/package.json').version,
      next: process.platform === 'linux' ? 'Deploy server here; enroll from a desktop maintenance machine.' : 'install' });
    if (!docker || !compose) throw fail('docker_or_compose_unavailable');
    return;
  }
  if (command === 'browser-install' || command === 'repair') {
    if (options.env) {
      const env = envRead(path.resolve(options.env));
      if (!env.IMA_QA_ADMIN_TOKEN || !env.IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID) throw fail('provider_private_configuration_required');
    }
    const state = await configureBrowser(root, options, emit);
    if (options.env) {
      const file = path.resolve(options.env); const env = envRead(file);
      if (!env.IMA_QA_ADMIN_TOKEN || !env.IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID) throw fail('provider_private_configuration_required');
      const config = JSON.parse(fs.readFileSync(state.config, 'utf8'));
      const endpoint = `ws://host.docker.internal:${config.port}/${config.key}`;
      if (env.IMA_ENROLLMENT_BROWSER_ENDPOINT && env.IMA_ENROLLMENT_BROWSER_ENDPOINT !== endpoint) throw fail('existing_browser_endpoint_protected');
      const before = fs.readFileSync(file, 'utf8');
      if (!env.IMA_ENROLLMENT_BROWSER_ENDPOINT) {
        privateWrite(`${file}.before-enrollment-helper`, before);
        privateReplace(file, `${before}\nIMA_ENROLLMENT_BROWSER_ENDPOINT=${endpoint}\nIMA_WEB_AGENT_ENROLLMENT_BROWSER_MODE=visible\n`);
      }
      emit({ stage: 'browser_configured', credentialsConfigured: true, providerRestarted: false,
        next: 'For a new install start Provider now; existing services require an idle maintenance window.' });
    }
    return state;
  }
  if (command === 'uninstall') {
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'helper-state.json'), 'utf8'));
    validateHelperState(state, root, directory);
    if (process.platform === 'darwin') await run('launchctl', ['bootout', `gui/${process.getuid()}/${state.label}`]).catch(() => {});
    else {
      const quote = value => `'${String(value).replaceAll("'", "''")}'`;
      const args = [path.join(root, 'scripts/enrollment-browser-helper.mjs'), state.config].map(a => `"${a.replaceAll('"', '')}"`).join(' ');
      await run('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskName '${state.label}' -ErrorAction SilentlyContinue; if($task){if($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne ${quote(process.execPath)} -or $task.Actions[0].Arguments -ne ${quote(args)}){throw 'Foreign helper task'}; Stop-ScheduledTask -TaskName '${state.label}'; Unregister-ScheduledTask -TaskName '${state.label}' -Confirm:$false}`]);
    }
    for (const file of [state.definition, state.config, path.join(directory, 'helper-state.json')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    emit({ stage: 'helper_removed', providerDataPreserved: true, next: 'Enrollment is now unavailable; the Provider configuration and account data were not changed.' }); return;
  }
  if (command === 'install') {
    if (fs.existsSync(statePath) || fs.existsSync(options.env || path.join(root, '.env'))) throw fail('existing_installation_protected');
    if (fs.existsSync(journal)) throw fail('installation_pending_use_resume');
    const mode = options.mode || (process.platform === 'linux' ? 'server' : 'desktop');
    if (!['server', 'desktop'].includes(mode)) throw fail('invalid_mode');
    await guided(root, 'doctor', options, emit, dependencies);
    const project = projectName(options.project); const hostPort = port(options.port, 3117);
    if (await readCommand('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])) throw fail('existing_compose_project_protected');
    await (dependencies.portAvailable || portAvailable)(hostPort);
    const image = options.image || `ghcr.io/19chris19/ima-qa-web-agent:v${require('../package.json').version}`;
    if (!/^[a-z0-9][a-z0-9./:_@-]+$/.test(image)) throw fail('invalid_image');
    await execute('docker', ['pull', image], { timeout: 300000, code: 'image_unavailable' });
    const digests = JSON.parse(await readCommand('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', image]));
    const repository = image.split('@')[0].replace(/:[^/:]+$/, '');
    const pinned = digests.find(value => value.startsWith(`${repository}@sha256:`) && /^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(value));
    if (!pinned) throw fail('image_digest_unverified');
    // Check the maintenance protocol before writing configuration or starting services.
    await execute('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', pinned, '-e',
      `if(require('playwright-core/package.json').version!==${JSON.stringify(require('playwright-core/package.json').version)}||!require('node:fs').existsSync('scripts/onboard.mjs'))process.exit(1)`], { code: 'browser_protocol_version_mismatch' });
    const target = await resolveGuidedTarget(root, { ...options, mode, project }, emit, dependencies);
    const env = path.join(directory, 'provider.env');
    const compose = path.join(directory, 'compose.json');
    const state = { schemaVersion: 1, root, image: pinned, project, env, compose, mode, hostPort,
      version: require('../package.json').version, target: { knowledgeBaseId: target.knowledgeBaseId, name: target.name, shareUrl: target.shareUrl } };
    privateWrite(journal, JSON.stringify(state));
    if (mode === 'desktop') {
      await configureBrowser(root, { ...options, project }, emit);
    }
    finishConfiguration(state);
    emit({ stage: 'configured', credentialsConfigured: true, next: 'resume' });
    await guided(root, 'resume', options, emit, dependencies); return;
  }
  if (command === 'resume' || command === 'check') {
    if (command === 'resume' && !fs.existsSync(statePath) && fs.existsSync(journal)) {
      const pending = JSON.parse(fs.readFileSync(journal, 'utf8'));
      if (pending.mode === 'desktop') await configureBrowser(root, { ...options, project: pending.project }, emit);
      finishConfiguration(pending);
    }
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.root !== root || state.schemaVersion !== 1) throw fail('installation_owner_mismatch');
    if (command === 'resume') await execute('docker', ['compose', '-p', state.project, '-f', state.compose, 'up', '-d', '--no-build', '--no-recreate', '--wait'], { code: 'service_start_failed' });
    const env = envRead(state.env);
    const response = await fetchImpl(`http://127.0.0.1:${state.hostPort}/api/admin/bootstrap`, {
      headers: { authorization: `Bearer ${env.IMA_QA_ADMIN_TOKEN}` }, signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok || data.provider !== 'ima-web-agent') throw fail('provider_authentication_failed');
    if (String(data.sharedKnowledgeBaseId) !== state.target.knowledgeBaseId || data.enrollment?.authorizationProtocol !== 'shared_library_membership_v1') throw fail('provider_onboarding_contract_mismatch');
    let browserReady = false;
    if (state.mode === 'desktop') {
      const probe = await fetchImpl(`http://127.0.0.1:${state.hostPort}/api/admin/enrollment-preflight`, {
        method: 'POST', headers: { authorization: `Bearer ${env.IMA_QA_ADMIN_TOKEN}` }, signal: AbortSignal.timeout(10000) });
      browserReady = probe.ok && (await probe.json()).enrollment?.ready === true;
      if (!browserReady) throw fail('browser_helper_not_ready_use_repair');
    }
    emit({ stage: 'service_started', version: state.version, adminUrl: `http://127.0.0.1:${state.hostPort}/admin.html`,
      enrollmentMode: state.mode === 'desktop' ? 'desktop_helper' : 'remote_cli',
      browserReady, credentialsConfigured: true, realQaVerified: false, next: 'Human scan and knowledge-base authorization required.' }); return;
  }
  if (command === 'enroll') {
    let envPath = options.env; let serverUrl = options.serverUrl;
    if (!envPath && fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')); envPath = state.env; serverUrl ||= `http://127.0.0.1:${state.hostPort}`;
    }
    if (!envPath || !serverUrl) throw fail('maintenance_private_env_and_server_url_required');
    const env = envRead(path.resolve(envPath));
    const parsed = new URL(serverUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'http:' || parsed.username || parsed.password) throw fail('loopback_ssh_tunnel_required');
    if (!options.name) throw fail('account_name_required');
    emit({ stage: 'human_action_required', action: 'Use an account joined to the target library; scan and authorize only in official IMA.',
      shareUrl: env.IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_SHARE_URL || options.shareUrl || '', realQaProbe: 'Enrollment may perform one declared knowledge QA verification.' });
    const browser = await configureBrowser(root, options, emit);
    const config = JSON.parse(fs.readFileSync(browser.config, 'utf8'));
    await run(process.execPath, [path.join(root, 'scripts/enroll-web-agent-account.mjs'), '--name', options.name, '--server-url', serverUrl],
      { cwd: root, interactive: true, timeout: 900000, env: { ...process.env, ...env, IMA_WEB_AGENT_BROWSER_PATH: config.browserPath }, code: 'enrollment_failed' }); return;
  }
  if (command === 'tunnel') {
    if (!options.ssh || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}$/.test(options.ssh)) throw fail('ssh_alias_required');
    await run('ssh', ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${port(options.localPort, 13317)}:127.0.0.1:${port(options.remotePort, 3117)}`, options.ssh],
    { interactive: true, timeout: 3600000, code: 'ssh_tunnel_failed' }); return;
  }
  if (command === 'remote-prepare') {
    if (!options.ssh || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}$/.test(options.ssh)
      || !/^\/[a-zA-Z0-9_./-]+$/.test(options.remoteEnv || '')) throw fail('ssh_alias_and_absolute_private_env_required');
    const env = dotenv.parse(await readCommand('ssh', [options.ssh, 'cat', options.remoteEnv]));
    if (!env.IMA_QA_ADMIN_TOKEN || !env.IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID || !env.IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_SHARE_URL) throw fail('server_configuration_incomplete');
    const target = { knowledgeBaseId: env.IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID,
      shareUrl: parseShareUrl(env.IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_SHARE_URL).url };
    if (!/^[1-9][0-9]{0,29}$/.test(target.knowledgeBaseId)) throw fail('server_configuration_incomplete');
    const file = path.join(directory, 'remote-admin.env');
    privateWrite(file, `IMA_QA_ADMIN_TOKEN=${env.IMA_QA_ADMIN_TOKEN}\nIMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID=${target.knowledgeBaseId}\nIMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_SHARE_URL=${target.shareUrl}\n`);
    emit({ stage: 'maintenance_configured', privateEnv: file, credentialsConfigured: true,
      next: 'Open the SSH tunnel, then onboard enroll --env <privateEnv> --server-url http://127.0.0.1:<local-port> --name <account-name>' }); return;
  }
  throw fail('unknown_command');
}
module.exports = { guided, resolveGuidedTarget, parseOptions, privateWrite, maintenanceSpec, composeSpec, helperProbe, finishHelperFiles, validateHelperState };
