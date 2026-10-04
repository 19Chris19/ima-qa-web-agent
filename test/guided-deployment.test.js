const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { maintenanceSpec, composeSpec, privateWrite, parseOptions, guided, finishHelperFiles } = require('../src/guided-deployment');
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
test('synthetic server install pins the image, pauses for human authorization and can safely resume', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-install-')); const events = []; const commands = [];
  const deps = { run: async (bin, args) => commands.push([bin, ...args]),
    capture: async (bin, args) => args[0] === 'ps' ? '' : JSON.stringify(['synthetic/provider@sha256:' + 'a'.repeat(64)]),
    portAvailable: async () => {}, fetch: async url => url.includes('/bootstrap')
      ? Response.json({ provider: 'ima-web-agent', enrollment: { supportsAdminPageQr: false } }) : new Response(fixture()) };
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
