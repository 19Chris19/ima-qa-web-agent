import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, uninstall } from '../src/install.mjs';
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
