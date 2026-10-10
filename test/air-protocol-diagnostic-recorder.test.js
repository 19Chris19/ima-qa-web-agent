const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProtocolDiagnosticRecorder,
} = require('../src/air/protocol-diagnostic-recorder');
const { parseIMAWebAgentStream } = require('../src/ima-upstream-protocol');

function descriptor(overrides = {}) {
  return {
    eventName: 'STRUCTURED_BLOCK',
    eventFamily: 'unknown',
    recognized: false,
    recognitionCategory: 'unrecognized',
    fieldSignatures: ['Data:object', 'Data.NewShape:object', 'Data.NewShape.Text:string'],
    signatureFailureCategory: '',
    textLengthBucket: 'empty',
    structuredBlockSubtype: 'newShape',
    structuredBlockValidationCategory: 'not_reference_indexes',
    structuredBlockPositionCategory: 'not_positions',
    completionCategory: 'not_terminal',
    structuredBlockType: 'newShape',
    ...overrides,
  };
}

function secureTemporaryDirectory(prefix) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.chmodSync(directory, 0o700);
  return directory;
}

test('ProtocolDiagnosticRecorder writes only sanitized descriptors and allowlisted errors', () => {
  const directory = secureTemporaryDirectory('ima-protocol-diagnostic-');
  const filePath = path.join(directory, 'events.jsonl');
  const recorder = new ProtocolDiagnosticRecorder({
    filePath,
    clock: () => '2026-09-04T00:00:00.000Z',
  });

  recorder.observe(descriptor({
    eventName: 'STRUCTURED_BLOCK\nprivate-answer',
    fieldSignatures: [
      'Data:object',
      'Data.[redacted]:string',
      'credential:string',
      'private-answer',
    ],
    rawAnswer: 'private-answer',
    accountId: 'private-account',
  }));
  recorder.recordError('protocol_variant_unrecognized');
  recorder.recordError('private-error-with-user-content');

  const stored = fs.readFileSync(filePath, 'utf8');
  const rows = stored.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].schema_version, 'ima.upstream.protocol-diagnostic.v1');
  assert.equal(rows[0].kind, 'event_descriptor');
  assert.equal(rows[0].error_code, 'protocol_variant_unrecognized');
  assert.match(rows[0].descriptor.event_name, /^unknown_[0-9a-f]{16}$/u);
  assert.deepEqual(rows[0].descriptor.field_signatures, [
    'Data.redacted:string',
    'Data:object',
  ]);
  assert.deepEqual(rows[1], {
    schema_version: 'ima.upstream.protocol-diagnostic.v1',
    observed_at: '2026-09-04T00:00:00.000Z',
    kind: 'error_code',
    error_code: 'protocol_variant_unrecognized',
  });
  assert.doesNotMatch(stored, /private-answer|private-account|private-error/u);
});

test('ProtocolDiagnosticRecorder stores only allowlisted normalization categories', () => {
  const directory = secureTemporaryDirectory('ima-protocol-normalization-');
  const filePath = path.join(directory, 'events.jsonl');
  const recorder = new ProtocolDiagnosticRecorder({
    filePath,
    clock: () => '2026-09-04T00:00:00.000Z',
  });

  assert.equal(recorder.recordNormalization('structured_auxiliary_recovered'), true);
  assert.equal(recorder.recordNormalization('source_snippet_truncated'), true);
  assert.equal(recorder.recordNormalization('source_item_discarded'), true);
  assert.equal(recorder.recordNormalization('private-answer'), false);

  const stored = fs.readFileSync(filePath, 'utf8');
  const rows = stored.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.normalization_category), [
    'structured_auxiliary_recovered',
    'source_snippet_truncated',
    'source_item_discarded',
  ]);
  assert.equal(rows.every((row) => row.kind === 'normalization_category'), true);
  assert.doesNotMatch(stored, /private-answer/u);
});

test('ProtocolDiagnosticRecorder preserves only safe structured block type tokens', () => {
  const directory = secureTemporaryDirectory('ima-protocol-type-token-');
  const filePath = path.join(directory, 'events.jsonl');
  const recorder = new ProtocolDiagnosticRecorder({ filePath });

  recorder.observe(descriptor({ structuredBlockType: 'referenceIndexProgress' }));
  recorder.observe(descriptor({ structuredBlockType: 'private answer with spaces' }));

  const rows = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].descriptor.structured_block_type, 'referenceIndexProgress');
  assert.equal(rows[1].descriptor.structured_block_type, 'redacted');
  assert.doesNotMatch(JSON.stringify(rows), /private answer/u);
});

test('ProtocolDiagnosticRecorder skips recognized events to avoid hot-path storage growth', () => {
  const directory = secureTemporaryDirectory('ima-protocol-recognized-');
  const filePath = path.join(directory, 'events.jsonl');
  const recorder = new ProtocolDiagnosticRecorder({ filePath });

  assert.equal(recorder.observe(descriptor({
    eventFamily: 'message',
    recognized: true,
    recognitionCategory: 'recognized',
  })), false);
  assert.equal(fs.existsSync(filePath), false);
});

test('protocol descriptor observer failures never change normalized stream semantics', async () => {
  const body = [
    'event: MESSAGE\ndata: {"Text":"synthetic-answer"}',
    'event: COMPLETED\ndata: {"Code":0}',
  ].join('\n\n');
  const response = new Response(`${body}\n\n`);
  const events = [];

  for await (const event of parseIMAWebAgentStream(response, {
    onEventDescriptor() {
      throw new Error('synthetic-observer-failure');
    },
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: 'delta', text: 'synthetic-answer' },
    { type: 'done' },
  ]);
});

test('ProtocolDiagnosticRecorder rotates within its byte and file bounds', () => {
  const directory = secureTemporaryDirectory('ima-protocol-rotation-');
  const filePath = path.join(directory, 'events.jsonl');
  const recorder = new ProtocolDiagnosticRecorder({
    filePath,
    maxBytes: 1_024,
    maxFiles: 3,
  });

  for (let index = 0; index < 80; index += 1) {
    recorder.observe(descriptor({ structuredBlockSubtype: `shape${index}` }));
  }

  const names = fs.readdirSync(directory).sort();
  assert.deepEqual(names, ['events.jsonl', 'events.jsonl.1', 'events.jsonl.2']);
  for (const name of names) {
    const status = fs.statSync(path.join(directory, name));
    assert.equal(status.mode & 0o777, 0o600);
    assert.ok(status.size <= 1_024);
  }
});

test('ProtocolDiagnosticRecorder hashes unknown event names and field path segments', () => {
  const directory = secureTemporaryDirectory('ima-protocol-hashing-');
  const filePath = path.join(directory, 'events.primary.jsonl');
  const recorder = new ProtocolDiagnosticRecorder({ filePath });

  recorder.observe(descriptor({
    eventName: 'ATTACKER_EVENT_NAME',
    fieldSignatures: [
      'Data.PrivateCustomerShape.CustomPayload:string',
      'Data.KnownContainer[].AnotherPrivateName:number',
    ],
  }));

  const stored = fs.readFileSync(filePath, 'utf8');
  const row = JSON.parse(stored);
  assert.match(row.descriptor.event_name, /^unknown_[0-9a-f]{16}$/u);
  assert.deepEqual(row.descriptor.field_signatures.length, 2);
  assert.match(stored, /field_[0-9a-f]{16}/u);
  assert.doesNotMatch(
    stored,
    /ATTACKER_EVENT_NAME|PrivateCustomerShape|CustomPayload|KnownContainer|AnotherPrivateName/u,
  );
});

test('ProtocolDiagnosticRecorder requires a pre-existing owner-only non-symlink directory', () => {
  const parent = secureTemporaryDirectory('ima-protocol-directory-');
  const missing = path.join(parent, 'missing', 'events.jsonl');
  assert.throws(
    () => new ProtocolDiagnosticRecorder({ filePath: missing }),
    /protocol_diagnostic_directory/u,
  );

  const permissive = path.join(parent, 'permissive');
  fs.mkdirSync(permissive, { mode: 0o755 });
  assert.throws(
    () => new ProtocolDiagnosticRecorder({ filePath: path.join(permissive, 'events.jsonl') }),
    /protocol_diagnostic_directory_insecure/u,
  );

  const secure = path.join(parent, 'secure');
  fs.mkdirSync(secure, { mode: 0o700 });
  const alias = path.join(parent, 'alias');
  fs.symlinkSync(secure, alias, 'dir');
  assert.throws(
    () => new ProtocolDiagnosticRecorder({ filePath: path.join(alias, 'events.jsonl') }),
    /protocol_diagnostic_directory_invalid/u,
  );
});

test('ProtocolDiagnosticRecorder refuses symlink and permissive targets without throwing from observers', () => {
  const directory = secureTemporaryDirectory('ima-protocol-target-');
  const destination = path.join(directory, 'destination');
  fs.writeFileSync(destination, 'unchanged', { mode: 0o600 });
  const symlinkPath = path.join(directory, 'events.symlink.jsonl');
  fs.symlinkSync(destination, symlinkPath);
  assert.throws(
    () => new ProtocolDiagnosticRecorder({ filePath: symlinkPath }),
    /protocol_diagnostic_target_invalid/u,
  );

  const filePath = path.join(directory, 'events.primary.jsonl');
  const recorder = new ProtocolDiagnosticRecorder({ filePath });
  fs.writeFileSync(filePath, 'unsafe', { mode: 0o644 });
  fs.chmodSync(filePath, 0o644);
  assert.equal(recorder.observe(descriptor()), false);
  assert.equal(recorder.recordError('protocol_variant_unrecognized'), false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'unsafe');
});

test('ProtocolDiagnosticRecorder requires a bounded absolute destination', () => {
  assert.throws(
    () => new ProtocolDiagnosticRecorder({ filePath: 'relative/events.jsonl' }),
    /protocol_diagnostic_path_invalid/u,
  );
  assert.throws(
    () => new ProtocolDiagnosticRecorder({ filePath: '/tmp/events.jsonl', maxBytes: 10 }),
    /protocol_diagnostic_max_bytes_invalid/u,
  );
  assert.throws(
    () => new ProtocolDiagnosticRecorder({ filePath: '/tmp/events.jsonl', maxFiles: 99 }),
    /protocol_diagnostic_max_files_invalid/u,
  );
});
