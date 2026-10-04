const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { maintenanceSpec, composeSpec, privateWrite, parseOptions, guided, resolveGuidedTarget, finishHelperFiles, validateHelperState } = require('../src/guided-deployment');
const { fixture } = require('./helpers/share-metadata');

test('desktop helpers are user scoped and preserve spaces in executable paths', () => {
  const common = { project: 'synthetic-qa', node: '/a path/node', script: '/a path/helper.mjs', config: '/private/config.json' };
  const mac = maintenanceSpec('darwin', common);
  assert.match(mac.label, /^com\.ima\.enrollment\./);
  assert.ok(mac.document.includes('/a path/node'));
  assert.ok(mac.document.includes('RunAtLoad'));
  const win = maintenanceSpec('win32', { ...common, node: 'C:\\a path\\node.exe' });
  assert.match(win.document, /Register-ScheduledTask/);
  assert.match(win.document, /AtLogOn/);
  assert.match(win.document, /RunLevel Limited/);
  assert.throws(() => maintenanceSpec('linux', common), /maintenance_desktop_required/);
});
test('compose uses an isolated volume, loopback ports and no host networking', () => {
  const spec = composeSpec({ image: 'synthetic/provider:fixture', env: '/private/provider.env', port: 13317, project: 'fixture' });
  assert.deepEqual(spec.services['ima-qa-web'].ports, ['127.0.0.1:13317:3000']);
  assert.equal(spec.services['ima-qa-web'].network_mode, undefined);
  assert.equal(spec.services['ima-qa-web'].privileged, undefined);
  assert.equal(spec.services['ima-qa-web'].restart, 'unless-stopped');
});
test('private writes cannot overwrite an existing installation and errors never quote contents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-fixture-')); const file = path.join(dir, 'private.env');
  try {
    privateWrite(file, 'synthetic_secret');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => privateWrite(file, 'replacement'), /existing_installation_protected/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic_secret');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('argument parser rejects missing values, duplicates and unknown options', () => {
  assert.equal(parseOptions(['--share-url', 'https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64)]).shareUrl.startsWith('https:'), true);
  for (const args of [['--env'], ['--env', '/a', '--env', '/b'], ['--token', 'do-not-print']]) {
    assert.throws(() => parseOptions(args), /invalid_arguments/);
  }
});
test('interrupted helper file preparation resumes without overwriting foreign files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-resume-'));
  const state = { config: path.join(dir, 'config.json'), definition: path.join(dir, 'helper.plist'), configuration: { key: 'synthetic' }, document: 'synthetic definition' };
  try {
    privateWrite(state.config, JSON.stringify(state.configuration));
    finishHelperFiles(state); finishHelperFiles(state);
    assert.equal(fs.readFileSync(state.definition, 'utf8'), state.document);
    fs.writeFileSync(state.definition, 'foreign');
    assert.throws(() => finishHelperFiles(state), /existing_helper_protected/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('helper ownership validates paths and definitions before repair or uninstall', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-owner-'));
  const directory = path.join(root, '.onboarding');
  const platform = 'darwin';
  const spec = maintenanceSpec(platform, { project: 'synthetic-owner', node: process.execPath,
    script: path.join(root, 'scripts/enrollment-browser-helper.mjs'), config: path.join(directory, 'browser.json') });
  const state = { root, project: 'synthetic-owner', platform,
    playwrightVersion: require('playwright-core/package.json').version, config: path.join(directory, 'browser.json'),
    definition: path.join(os.homedir(), 'Library/LaunchAgents', `${spec.label}.plist`),
    label: spec.label, document: spec.document, configuration: { port: 12345, key: 'a'.repeat(64), browserPath: '/synthetic/chromium' } };
  try {
    assert.doesNotThrow(() => validateHelperState(state, root, directory, platform));
    for (const changed of [{ config: '/foreign/config.json' }, { definition: '/foreign/task' },
      { label: 'foreign.task' }, { document: 'foreign task definition' }]) {
      assert.throws(() => validateHelperState({ ...state, ...changed }, root, directory, platform), /helper_version_or_owner_mismatch/);
    }
    privateWrite(state.config, 'foreign contents');
    assert.throws(() => validateHelperState(state, root, directory, platform), /existing_helper_protected/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('synthetic server install pins the image, pauses for human authorization and can safely resume', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-install-')); const events = []; const commands = [];
  const deps = { run: async (bin, args) => commands.push([bin, ...args]),
    capture: async (bin, args) => args[0] === 'ps' ? '' : JSON.stringify(['synthetic/provider@sha256:' + 'a'.repeat(64)]),
    portAvailable: async () => {}, fetch: async url => url.includes('/bootstrap')
      ? Response.json({ provider: 'ima-web-agent', sharedKnowledgeBaseId: '123456789', enrollment: { supportsAdminPageQr: false, authorizationProtocol: 'shared_library_membership_v1' } }) : new Response(fixture()) };
  const options = { mode: 'server', image: 'synthetic/provider:fixture', shareUrl: 'https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64) };
  try {
    await guided(root, 'install', options, e => events.push(e), deps);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.onboarding/deployment.json')));
    assert.match(state.image, /@sha256:/);
    const before = fs.readFileSync(state.env, 'utf8');
    assert.ok(before.includes('IMA_QA_ADMIN_TOKEN='));
    assert.ok(!JSON.stringify(events).includes(before.match(/IMA_QA_ADMIN_TOKEN=(.*)/)[1]));
    assert.equal(events.at(-1).realQaVerified, false);
    await assert.rejects(guided(root, 'install', options, () => {}, deps), /existing_installation_protected/);
    await guided(root, 'resume', options, () => {}, deps);
    assert.equal(fs.readFileSync(state.env, 'utf8'), before);
    assert.ok(commands.every(args => !args.includes('down') && !args.includes('--force-recreate')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('foreign projects and protocol failures block before any secret is generated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-block-'));
  const options = { mode: 'server', image: 'synthetic/provider:fixture', shareUrl: 'https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64) };
  const deps = { run: async () => {}, capture: async () => 'foreign-container', fetch: async () => new Response(fixture()), portAvailable: async () => {} };
  try {
    await assert.rejects(guided(root, 'install', options, () => {}, deps), /existing_compose_project_protected/);
    assert.equal(fs.existsSync(path.join(root, '.onboarding/provider.env')), false);
    deps.capture = async (_, args) => args[0] === 'ps' ? '' : JSON.stringify(['synthetic/provider@sha256:' + 'a'.repeat(64)]);
    deps.run = async (_, args) => { if (args[0] === 'run') throw new Error('browser_protocol_version_mismatch'); };
    await assert.rejects(guided(root, 'install', options, () => {}, deps), /browser_protocol_version_mismatch/);
    assert.equal(fs.existsSync(path.join(root, '.onboarding/provider.env')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('SSH preparation keeps only maintenance credentials locally and never prints them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-fixture-')); const events = [];
  try {
    const deps = { capture: async () => 'IMA_QA_ADMIN_TOKEN=synthetic-admin\nIMA_QA_API_TOKEN=synthetic-ordinary\nIMA_QA_INTERNAL_SERVICE_TOKEN=synthetic-internal\nIMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID=123456789\nIMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_SHARE_URL=https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64), fetch: async () => new Response(fixture()) };
    await guided(root, 'remote-prepare', { ssh: 'synthetic-server', remoteEnv: '/private/provider.env' }, e => events.push(e), deps);
    const text = fs.readFileSync(path.join(root, '.onboarding/remote-admin.env'), 'utf8');
    assert.ok(text.includes('synthetic-admin'));
    assert.ok(!text.includes('synthetic-internal') && !text.includes('synthetic-ordinary'));
    assert.ok(!JSON.stringify(events).includes('synthetic-admin'));
    await assert.rejects(guided(root, 'remote-prepare', { ssh: '-oProxyCommand=evil', remoteEnv: '/private/provider.env' }, () => {}, deps), /ssh_alias/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('a desktop-resolved manifest carries only target metadata to server installation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-manifest-'));
  const file = path.join(root, '.onboarding/target.json');
  const shareUrl = 'https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64);
  try {
    await resolveGuidedTarget(root, { shareUrl, targetFile: file, mode: 'server' }, () => {}, { fetch: async () => new Response(fixture()) });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file))), ['schemaVersion', 'shareUrl', 'knowledgeBaseId', 'name']);
    assert.equal((await resolveGuidedTarget(root, { shareUrl, targetFile: file, mode: 'server' }, () => {}, { fetch: async () => { throw Error('should not fetch'); } })).knowledgeBaseId, '123456789');
    await assert.rejects(resolveGuidedTarget(root, { shareUrl: shareUrl.replace(/a/g, 'b'), targetFile: file }, () => {}), /target_manifest_invalid|official_share_url_required/);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, shareUrl, knowledgeBaseId: 'a'.repeat(64), name: 'Synthetic' }));
    await assert.rejects(resolveGuidedTarget(root, { shareUrl, targetFile: file }, () => {}), /target_manifest_invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
