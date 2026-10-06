import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
const require = createRequire(import.meta.url);
const { readSnapshot, buildTransfer, prepareTransfer } = require('../src/account-transfer');
const { applyPreparedTransfer } = require('../src/offline-transfer-apply');
const { values } = parseArgs({ options: {
  help: { type: 'boolean' }, prepare: { type: 'boolean' },
  'source-store': { type: 'string' }, 'source-key': { type: 'string' },
  'target-store': { type: 'string' }, 'target-key': { type: 'string' },
  'knowledge-base-id': { type: 'string' }, output: { type: 'string' }, 'history-store': { type: 'string' },
  apply: { type: 'boolean' }, rollback: { type: 'boolean' }, bundle: { type: 'string' },
  'source-port': { type: 'string' }, 'target-port': { type: 'string' },
} });
if (values.help) {
  console.log('Persistent retirement: apply seals the entire source store before importing disabled targets. Marker-aware startup refuses retired stores. Explicit rollback releases only after journaled safe removal; old binaries MUST remain stopped. See docs/SOURCE_RETIREMENT.md.');
  console.log('Read-only preflight: node scripts/prepare-account-transfer.mjs --source-store PATH --source-key PATH --target-store PATH --target-key PATH --knowledge-base-id ID\nAdd --prepare --output PRIVATE_NEW_DIRECTORY [--history-store PATH] to create a private bundle without changing live stores.\nOffline apply: replace --prepare with --apply --bundle DIRECTORY --source-port PORT --target-port PORT. Both services must use the shared startup fence and be fully stopped; disable old launchers/automatic restarts first. The tool holds both startup fences and store locks, checks IPv4/IPv6 listeners and compares final snapshot hashes. Incoming accounts remain disabled. --rollback instead of --apply removes only unchanged unused imports, preserving unrelated newer data. Neither command starts services or verifies IMA.');
} else {
  try {
    const input = { sourceStore: values['source-store'], sourceKey: values['source-key'],
      targetStore: values['target-store'], targetKey: values['target-key'], knowledgeBaseId: values['knowledge-base-id'],
      output: values.output, historyStore: values['history-store'] };
    if ([values.apply, values.rollback, values.prepare].filter(Boolean).length > 1) throw new Error('transfer_modes_conflict');
    const offline = values.apply || values.rollback;
    if (!input.sourceStore || !input.sourceKey || !input.targetStore || !input.targetKey || (!offline && !input.knowledgeBaseId) || (values.prepare && !input.output) || (offline && !values.bundle)) throw new Error('transfer_arguments_required');
    const result = offline ? await applyPreparedTransfer({ ...input, bundle: values.bundle,
      sourcePort: Number(values['source-port']), targetPort: Number(values['target-port']), rollback: Boolean(values.rollback) }) : values.prepare ? prepareTransfer(input) : buildTransfer({
      source: readSnapshot(input.sourceStore, input.sourceKey), target: readSnapshot(input.targetStore, input.targetKey),
      knowledgeBaseId: input.knowledgeBaseId }).report;
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ error: /^(transfer|archive|account_store)_[a-z_]+$/.test(error.code || error.message)
      ? error.code || error.message : 'transfer_failed' })); process.exitCode = 1;
  }
}
