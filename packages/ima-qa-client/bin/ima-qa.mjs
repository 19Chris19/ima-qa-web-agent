#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, defaultConfig, fault } from '../src/config.mjs';
import { ImaClient, markdown } from '../src/client.mjs';

const strings = ['config', 'profile', 'conversation', 'request-key', 'wait', 'source-intent', 'format', 'output', 'agent',
  'install-dir', 'skills-dir', 'base-url', 'scope-ref', 'application-id', 'knowledge-base-name', 'version'];
function help() {
  return { commands: ['setup --agent codex [--config FILE]', 'doctor --json',
    'ask QUESTION --request-key UNIQUE_KEY [--conversation ID] [--wait 25] --json',
    'task ID [--wait 25] --json', 'conversation ID --json', 'cancel ID --json',
    'export ID --format markdown|json --output FILE [--force]', 'mcp', 'update --version agent-vX.Y.Z', 'uninstall --agent codex'],
  setup: 'For a new profile provide --base-url, --scope-ref (SHA-256 of configured KB ID), --application-id. Set IMA_QA_API_TOKEN and IMA_QA_INTERNAL_TOKEN, or store credentials in the private config. Both tokens must belong to the same Provider application.' };
}
async function main() {
  const { values, positionals } = parseArgs({ options: { ...Object.fromEntries(strings.map(x => [x, { type: 'string' }])),
    json: { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true });
  const [command, arg] = positionals;
  if (!command || values.help) return help();
  const options = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
  if (command === 'setup') {
    const { setup } = await import('../src/install.mjs');
    const result = await setup(options);
    try { result.provider = await new ImaClient(await loadConfig(result.configFile, options.profile)).status(); }
    catch (error) { result.provider = { ready: false, error: error.code || 'configuration_error' }; }
    return result;
  }
  if (command === 'uninstall') return (await import('../src/install.mjs')).uninstall(options);
  if (command === 'update') return (await import('../src/update.mjs')).update(options);
  if (!['doctor', 'ask', 'task', 'conversation', 'cancel', 'export', 'mcp'].includes(command)) throw fault('unknown_command');
  const client = new ImaClient(await loadConfig(values.config || defaultConfig(), values.profile || 'default'));
  const waitSeconds = values.wait === undefined ? (command === 'ask' ? 25 : 0) : Number(values.wait);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 25) throw fault('invalid_wait');
  switch (command) {
    case 'doctor': return client.status();
    case 'ask': return client.ask({ question: arg, conversationId: values.conversation, requestKey: values['request-key'], waitSeconds, sourceIntent: values['source-intent'] || 'knowledge' });
    case 'task': return client.task(arg, { waitSeconds });
    case 'conversation': return client.conversation(arg);
    case 'cancel': return client.cancel(arg);
    case 'mcp': await (await import('../src/mcp.mjs')).serve(client); return undefined;
    case 'export': {
      if (!values.output || !['json', 'markdown'].includes(values.format || 'markdown')) throw fault('invalid_export_options');
      const result = await client.task(arg);
      const text = values.format === 'json' ? JSON.stringify(result, null, 2) + '\n' : markdown(result);
      await writeFile(resolve(values.output), text, { flag: values.force ? 'w' : 'wx', mode: 0o600 });
      return { output: resolve(values.output), complete: result.complete, status: result.status };
    }
  }
}
try {
  const result = await main();
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.code || 'client_error', taskId: error.taskId, requestKey: error.requestKey,
    conversationId: error.conversationId, recovery: error.recovery, lockPath: error.lockPath }) + '\n');
  process.exitCode = 1;
}
