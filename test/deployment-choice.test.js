const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const shell = process.platform !== 'win32';
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-choice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'scripts'));
  for (const file of ['onboard.sh', 'scripts/deployment-choice.sh', 'scripts/private-runtime.sh']) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const log = path.join(dir, 'calls');
  const write = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
  write('uname', `printf 'uname %s\\n' "$*" >> "$CALLS"\ncase "$1" in -s) printf '%s\\n' "$TEST_OS" ;; -m) printf '%s\\n' "$TEST_ARCH" ;; *) exit 98 ;; esac`);
  if (options.docker !== false) write('docker', `printf 'docker %s\\n' "$*" >> "$CALLS"
case "$*" in
  'info --format {{.ServerVersion}}') printf '%s\\n' "$DOCKER_DETAIL" >&2; exit "$DOCKER_STATUS" ;;
  'compose version --short') printf '%s\\n' "$COMPOSE_VERSION"; exit "$COMPOSE_STATUS" ;;
  *) printf 'FORBIDDEN\\n' >> "$CALLS"; exit 98 ;;
esac`);
  if (options.node !== false) write('node', `printf 'node probe\\n' >> "$CALLS"
case "$*" in
  *process.versions*) exit "$NODE_STATUS" ;;
  *'require.resolve(name)'*) exit "$MODULE_STATUS" ;;
  *) printf 'FORBIDDEN\\n' >> "$CALLS"; exit 98 ;;
esac`);
  for (const command of ['curl', 'tar', 'npm', 'git', 'sudo', 'launchctl', 'open', 'mkdir']) {
    write(command, `printf 'FORBIDDEN ${command}\\n' >> "$CALLS"; exit 98`);
  }
  const env = { PATH: bin, HOME: dir, XDG_CACHE_HOME: path.join(dir, 'cache'), CALLS: log,
    TEST_OS: 'Darwin', TEST_ARCH: 'arm64', DOCKER_DETAIL: '', DOCKER_STATUS: '0',
    COMPOSE_VERSION: '2.39.0', COMPOSE_STATUS: '0', NODE_STATUS: '0', MODULE_STATUS: '0', ...options.env };
  return { dir, env, write, run(args) {
    const before = fs.readdirSync(dir).filter(f => f !== 'calls');
    const result = spawnSync('/bin/sh', [path.join(dir, 'onboard.sh'), ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(calls, /FORBIDDEN/);
    assert.deepEqual(fs.readdirSync(dir).filter(f => f !== 'calls'), before);
    const event = JSON.parse(result.stdout.trim());
    assert.equal(event.readOnly, true);
    assert.equal(event.credentialsPrinted, false);
    assert.ok(Array.isArray(event.missing));
    assert.ok(event.next);
    return { ...result, event, calls };
  } };
}

for (const action of ['choose', 'doctor', 'preflight', 'install', 'resolve', 'browser-install', 'repair', 'runtime']) {
  test(`${action}: missing mode refuses before all probes and writes`, { skip: !shell }, t => {
    const r = fixture(t).run([action]);
    assert.equal(r.status, 2);
    assert.deepEqual(r.event.missing, ['deployment_mode_required']);
    assert.equal(r.calls, '');
  });
}
for (const mode of ['online', 'shared', 'independent']) {
  test(`choose ${mode} has no runtime or Docker dependency`, { skip: !shell }, t => {
    const r = fixture(t, { node: false, docker: false }).run(['choose', '--deployment-mode', mode]);
    assert.equal(r.status, 0);
    assert.equal(r.event.stage, { online: 'online_access', shared: 'pending_invitation', independent: 'mode_selected' }[mode]);
    assert.equal(r.calls, '');
  });
}
for (const mode of ['online', 'shared']) {
  test(`${mode} preflight skips local dependencies; install refuses`, { skip: !shell }, t => {
    const f = fixture(t);
    assert.equal(f.run(['preflight', '--deployment-mode', mode]).calls, '');
    const r = f.run(['install', '--deployment-mode', mode]);
    assert.equal(r.status, 2);
    assert.deepEqual(r.event.missing, ['independent_mode_required']);
    assert.equal(r.calls, '');
  });
}
for (const args of [
  ['--deployment-mode', 'bad"secret'], ['--deployment-mode'],
  ['--deployment-mode', 'online', '--deployment-mode', 'independent'],
  ['--deployment-mode', 'independent', '--allow-bootstrap'],
  ['--mode', 'server'], ['--deployment-mode', 'independent', '--env', 'synthetic-secret'],
]) {
  test(`read-only argument refusal: ${JSON.stringify(args)}`, { skip: !shell }, t => {
    const r = fixture(t).run(['preflight', ...args]);
    assert.equal(r.status, 2);
    assert.equal(r.calls, '');
    assert.doesNotMatch(r.stdout + r.stderr, /synthetic-secret|bad"secret/);
  });
}

const scenarios = [
  ['Docker absent', { docker: false }, 'docker_cli'],
  ['daemon stopped', { env: { DOCKER_STATUS: '1', DOCKER_DETAIL: 'Cannot connect to the Docker daemon. synthetic-secret' } }, 'docker_daemon_stopped_or_unreachable'],
  ['permission denied', { env: { DOCKER_STATUS: '1', DOCKER_DETAIL: 'permission denied synthetic-secret' } }, 'docker_permission'],
  ['unknown daemon failure', { env: { DOCKER_STATUS: '1', DOCKER_DETAIL: 'TLS failure synthetic-secret' } }, 'docker_daemon_unavailable'],
  ['Compose absent', { env: { COMPOSE_STATUS: '1' } }, 'compose_v2'],
  ['Compose legacy', { env: { COMPOSE_VERSION: '1.29.0' } }, 'compose_v2'],
  ['Compose unparseable', { env: { COMPOSE_VERSION: 'unknown' } }, 'compose_v2'],
  ['Compose empty', { env: { COMPOSE_VERSION: '' } }, 'compose_v2'],
  ['Node absent', { node: false }, 'node_22'],
  ['Node old', { env: { NODE_STATUS: '1' } }, 'node_22'],
  ['modules absent', { env: { MODULE_STATUS: '1' } }, 'node_dependencies'],
  ['unsupported OS', { env: { TEST_OS: 'FreeBSD' } }, 'unsupported_os'],
  ['unsupported arch', { env: { TEST_ARCH: 'riscv64' } }, 'unsupported_arch'],
];
for (const [name, options, missing] of scenarios) {
  test(`independent preflight: ${name}`, { skip: !shell }, t => {
    const r = fixture(t, options).run(['preflight', '--deployment-mode', 'independent']);
    assert.equal(r.status, 2);
    assert.deepEqual(r.event.missing, [missing]);
    assert.doesNotMatch(r.stdout + r.stderr, /synthetic-secret/);
  });
}
for (const [system, arch, platform, normalized] of [
  ['Darwin', 'arm64', 'darwin', 'arm64'], ['Darwin', 'x86_64', 'darwin', 'x64'],
  ['Linux', 'aarch64', 'linux', 'arm64'], ['Linux', 'x86_64', 'linux', 'x64'],
]) {
  test(`dependency readiness ${system}/${arch} is not installation`, { skip: !shell }, t => {
    const r = fixture(t, { env: { TEST_OS: system, TEST_ARCH: arch } }).run(['doctor', '--deployment-mode', 'independent']);
    assert.equal(r.status, 0);
    assert.equal(r.event.stage, 'dependencies_ready');
    assert.equal(r.event.platform, platform);
    assert.equal(r.event.arch, normalized);
    assert.deepEqual(r.event.missing, []);
    assert.deepEqual(r.calls.trim().split('\n'), ['uname -s', 'uname -m',
      'docker info --format {{.ServerVersion}}', 'docker compose version --short', 'node probe', 'node probe']);
  });
}
for (const version of ['2.39.0', 'v2.39.0', '5.0.2', 'v5.0.2', '12.1.0']) {
  test(`Compose major >=2 accepts ${version}`, { skip: !shell }, t => {
    const r = fixture(t, { env: { COMPOSE_VERSION: version } }).run(['preflight', '--deployment-mode', 'independent']);
    assert.equal(r.status, 0); assert.equal(r.event.stage, 'dependencies_ready');
  });
}
test('direct Node entry refuses missing mode before loading application dependencies', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/onboard.mjs'), 'install'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stderr).missing, ['deployment_mode_required']);
});
test('direct Node choice delegates read-only without dependencies', { skip: !shell }, () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/onboard.mjs'), 'choose', '--deployment-mode', 'shared'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).stage, 'pending_invitation');
});
test('entry scripts contain no bootstrap, clone or dependency installation commands', () => {
  for (const file of ['onboard.sh', 'onboard.ps1', 'scripts/deployment-choice.sh', 'scripts/deployment-choice.ps1']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /Invoke-WebRequest|Expand-Archive|New-Item|curl |git clone|npm\.cmd|--accept-license|ExecutionPolicy|^\s*chmod |\bmv /m);
  }
});
for (const action of ['choose', 'doctor', 'preflight', 'resolve', 'repair']) {
  test(`${action} rejects bootstrap flag even with independent mode`, { skip: !shell }, t => {
    const r = fixture(t).run([action, '--deployment-mode', 'independent', '--allow-bootstrap']);
    assert.equal(r.status, 2); assert.equal(r.calls, '');
  });
}
for (const mode of [null, 'online', 'shared']) {
  test(`runtime bootstrap cannot bypass mode ${mode}`, { skip: !shell }, t => {
    const r = fixture(t).run(['runtime', ...(mode ? ['--deployment-mode', mode] : []), '--allow-bootstrap']);
    assert.equal(r.status, 2); assert.equal(r.calls, '');
  });
}
test('preflight accepts existing private Node without system Node or bootstrap', { skip: !shell }, t => {
  const f = fixture(t);
  const bin = path.join(f.env.XDG_CACHE_HOME, 'ima-qa-maintenance/node-v22.22.3-darwin-arm64/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.renameSync(path.join(f.dir, 'bin/node'), path.join(bin, 'node'));
  const r = f.run(['preflight', '--deployment-mode', 'independent']);
  assert.equal(r.status, 0); assert.equal(r.event.stage, 'dependencies_ready');
});
test('authorized runtime reuses private Node and strips consent flag before Node CLI', { skip: !shell }, t => {
  const f = fixture(t, { node: false });
  const bin = path.join(f.env.XDG_CACHE_HOME, 'ima-qa-maintenance/node-v22.22.3-darwin-arm64/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$1" in
  -e) exit 0 ;;
  scripts/onboard.mjs) printf '%s\\n' "$*" >> "$CALLS"; printf '{"stage":"synthetic_runtime","missing":[],"next":"synthetic","readOnly":true,"credentialsPrinted":false}\\n' ;;
  *) exit 98 ;;
esac\n`, { mode: 0o700 });
  f.write('mkdir', 'test -d "$2" || exit 98');
  const r = f.run(['runtime', '--deployment-mode', 'independent', '--allow-bootstrap']);
  assert.equal(r.status, 0);
  assert.match(r.calls, /scripts\/onboard.mjs runtime --deployment-mode independent/);
  assert.doesNotMatch(r.calls, /allow-bootstrap/);
});
test('private preparation retains checksum, no-overwrite and locked dependency guards', () => {
  const sh = fs.readFileSync(path.join(root, 'scripts/private-runtime.sh'), 'utf8');
  const ps = fs.readFileSync(path.join(root, 'scripts/private-runtime.ps1'), 'utf8');
  assert.match(sh, /--proto '=https' --tlsv1.2/);
  assert.match(sh, /test -n "\$EXPECTED" && test "\$EXPECTED" = "\$ACTUAL"/);
  assert.match(sh, /test ! -e "\$CACHE\/\$NAME"/);
  assert.match(sh, /npm ci --omit=dev/);
  assert.match(ps, /Get-FileHash -Algorithm SHA256/);
  assert.match(ps, /if \(Test-Path \$destination\)/);
  assert.match(ps, /npm.cmd ci --omit=dev/);
});
for (const scenario of ['success', 'checksum_mismatch', 'existing_destination']) {
  test(`authorized private bootstrap uses only synthetic tools: ${scenario}`, { skip: !shell }, t => {
    const f = fixture(t, { node: false });
    const name = 'node-v22.22.3-darwin-arm64';
    fs.mkdirSync(f.env.XDG_CACHE_HOME);
    const fakeNode = path.join(f.dir, 'synthetic-node');
    fs.writeFileSync(fakeNode, `#!/bin/sh
if [ "$1" = -e ]; then exit 1; fi
printf '{"stage":"synthetic_runtime","missing":[],"next":"synthetic","readOnly":true,"credentialsPrinted":false}\\n'
`, { mode: 0o700 });
    f.env.TEST_NODE = fakeNode; f.env.TEST_NAME = name;
    for (const binary of ['mkdir', 'mv', 'rm']) f.write(binary, `/bin/${binary} "$@"`);
    f.write('mktemp', '/usr/bin/mktemp "$@"');
    f.write('curl', `printf 'synthetic curl\\n' >> "$CALLS"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; printf 'synthetic archive/checksum fixture\\n' > "$1"; exit 0; fi
  shift
done
exit 98`);
    f.write('awk', `printf 'synthetic-hash\\n'`);
    f.write('sha256sum', `printf 'synthetic-hash\\n'`);
    if (scenario === 'checksum_mismatch') f.write('awk', `case "$*" in *'-v name='*) printf 'expected\\n' ;; *) printf 'different\\n' ;; esac`);
    f.write('tar', `printf 'synthetic tar\\n' >> "$CALLS"
/bin/mkdir -p "$4/$TEST_NAME/bin"
/bin/cp "$TEST_NODE" "$4/$TEST_NAME/bin/node"`);
    f.write('npm', `printf 'synthetic npm %s\\n' "$*" >> "$CALLS"`);
    const destination = path.join(f.env.XDG_CACHE_HOME, 'ima-qa-maintenance', name);
    if (scenario === 'existing_destination') {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'preserve'), 'synthetic-existing');
    }
    const result = spawnSync('/bin/sh', [path.join(f.dir, 'onboard.sh'), 'runtime', '--deployment-mode', 'independent', '--allow-bootstrap'], {
      env: f.env, encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    const calls = fs.readFileSync(f.env.CALLS, 'utf8');
    assert.doesNotMatch(calls, /FORBIDDEN|docker /);
    assert.equal(calls.match(/synthetic curl/g).length, 2);
    const cache = path.join(f.env.XDG_CACHE_HOME, 'ima-qa-maintenance');
    assert.equal(fs.readdirSync(cache).some(file => file.startsWith('download.')), false);
    if (scenario === 'success') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).stage, 'synthetic_runtime');
      assert.match(calls, /synthetic npm ci --omit=dev/);
    } else {
      assert.equal(result.status, 1);
      assert.doesNotMatch(calls, /synthetic npm/);
      if (scenario === 'checksum_mismatch') {
        assert.match(result.stderr, /checksum failed/); assert.doesNotMatch(calls, /synthetic tar/);
      } else {
        assert.match(result.stderr, /destination already exists/);
        assert.equal(fs.readFileSync(path.join(destination, 'preserve'), 'utf8'), 'synthetic-existing');
      }
    }
  });
}
test('numbered menu waits, rejects empty/invalid answers and only selects', { skip: !shell }, t => {
  const f = fixture(t);
  const python = spawnSync('python3', ['-c', 'import pty, sys; print(sys.executable)'], { encoding: 'utf8' });
  if (python.status !== 0) { t.skip('Python PTY support unavailable'); return; }
  const program = `import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
p = subprocess.Popen(['/bin/sh', sys.argv[1], 'choose'], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
def prompt():
    data = b''
    deadline = time.monotonic() + 3
    while b'Selection:' not in data:
        assert time.monotonic() < deadline, data
        if select.select([master], [], [], 0.1)[0]: data += os.read(master, 8192)
    assert p.poll() is None
    assert not os.path.exists(os.environ['CALLS'])
    return data
try:
    prompt()
    os.write(master, b'\\n')
    prompt()
    os.write(master, b'99\\n')
    prompt()
    os.write(master, b'3\\n')
    data = b''
    while True:
        try:
            chunk = os.read(master, 8192)
            if not chunk: break
            data += chunk
        except OSError: break
    assert p.wait(timeout=3) == 0
    assert b'"stage":"mode_selected"' in data, data
    assert not os.path.exists(os.environ['CALLS'])
finally:
    if p.poll() is None: p.kill()
    p.wait()
    os.close(master)
`;
  const r = spawnSync(python.stdout.trim(), ['-c', program, path.join(f.dir, 'onboard.sh')], {
    env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
});
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
test('PowerShell choice and noninteractive refusal (no external probes)', { skip: pwsh.status !== 0 }, () => {
  for (const mode of ['online', 'shared', 'independent']) {
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'onboard.ps1'), 'choose', '--deployment-mode', mode], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).mode, mode);
  }
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'onboard.ps1'), 'choose'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.deepEqual(JSON.parse(r.stdout).missing, ['deployment_mode_required']);
});
