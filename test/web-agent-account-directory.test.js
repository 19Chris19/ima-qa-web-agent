const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildRuntimeEnvText } = require('../src/ima-web-agent-client');
const {
  WebAgentAccountDirectory,
  parseRuntimeEnvText,
} = require('../src/web-agent-account-directory');

function makeTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ima-account-directory-'));
}

test('WebAgentAccountDirectory imports runtime env without leaking secrets', () => {
  const tempDir = makeTempDirectory();
  const storePath = path.join(tempDir, 'accounts.json');
  const keyPath = path.join(tempDir, 'accounts.key');
  const runtimeEnvPath = path.join(tempDir, 'runtime', 'account-a.env');
  const directory = new WebAgentAccountDirectory({
    storePath,
    keyPath,
  });

  const runtimeEnvText = buildRuntimeEnvText({
    accountId: 'account-a',
    accountName: 'Account A',
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=user-1; IMA-TOKEN=token-a; IMA-REFRESH-TOKEN=refresh-a',
      'x-ima-bkn': '123',
    },
    modelId: 'official_3',
    modelType: 3,
    runtimeEnvPath,
    tokenExpiresAt: 1785257551943,
    refreshTokenExpiresAt: 1787842056525,
    refreshSkewMs: 600000,
    refreshIntervalMs: 30000,
  });

  const account = directory.upsertFromRuntimeEnv({
    runtimeEnvText,
    runtimeEnvPath,
    source: 'test',
  });

  const accounts = directory.listAccounts({ includeEvents: true });
  const health = directory.getHealthSnapshot();
  const detailedHealth = directory.getHealthSnapshot({ includeDetails: true });
  const poolAccounts = directory.getPoolAccounts();

  assert.equal(account.id, 'account-a');
  assert.equal(account.name, 'Account A');
  assert.equal(account.status, 'available');
  assert.equal(accounts[0].hasCredentials, true);
  assert.equal(JSON.stringify(accounts).includes('token-a'), false);
  assert.equal(JSON.stringify(accounts).includes('refresh-a'), false);
  assert.equal(JSON.stringify(health).includes('accounts'), false);
  assert.equal(health.storePath, undefined);
  assert.equal(detailedHealth.storePath, storePath);
  assert.equal(poolAccounts[0].headers['x-ima-cookie'].includes('IMA-TOKEN=token-a'), true);
  assert.equal(fs.existsSync(runtimeEnvPath), true);
  assert.match(fs.readFileSync(runtimeEnvPath, 'utf8'), /IMA_WEB_AGENT_ACCOUNT_ID='account-a'/);
  assert.equal(parseRuntimeEnvText(runtimeEnvText).knowledgeBaseId, 'web-kb-id');
});

test('WebAgentAccountDirectory toggles disabled state and removes accounts', () => {
  const tempDir = makeTempDirectory();
  const directory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });

  directory.upsertCapturedAccount({
    id: 'account-b',
    name: 'Account B',
    knowledgeBaseId: 'web-kb-id',
    runtimeEnvPath: path.join(tempDir, 'runtime', 'account-b.env'),
    headers: {
      'x-ima-cookie': 'IMA-UID=user-2; IMA-TOKEN=token-b; IMA-REFRESH-TOKEN=refresh-b',
      'x-ima-bkn': '456',
    },
  });

  const disabled = directory.setDisabled('account-b', true, 'maintenance');
  const enabled = directory.setDisabled('account-b', false);
  const wrotePath = directory.writeRuntimeEnvFile('account-b');
  const deleted = directory.deleteAccount('account-b');

  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.disabledReason, 'maintenance');
  assert.equal(enabled.status, 'available');
  assert.equal(enabled.disabledReason, '');
  assert.equal(fs.existsSync(wrotePath), true);
  assert.match(fs.readFileSync(wrotePath, 'utf8'), /IMA_WEB_AGENT_ACCOUNT_ID='account-b'/);
  assert.equal(deleted, true);
  assert.equal(directory.listAccounts().length, 0);
});

test('WebAgentAccountDirectory persists a sanitized health projection separately from local scheduling', () => {
  const tempDir = makeTempDirectory();
  const directory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
    now: () => '2026-09-02T00:00:00.000Z',
  });
  directory.upsertCapturedAccount({
    id: 'account-health',
    name: 'Account Health',
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=user-health; IMA-TOKEN=token-health; IMA-REFRESH-TOKEN=refresh-health',
      'x-ima-bkn': '123',
    },
  });

  const before = directory.listAccounts()[0];
  assert.equal(before.health.local_schedulable, true);
  assert.equal(before.health.session_valid, null);
  assert.equal(before.health.refreshable, true);
  assert.equal(before.health.status, 'needs_check');

  directory.recordAccountHealth('account-health', {
    operation: 'check',
    code: 'ok',
    checkedAt: '2026-09-02T00:00:01.000Z',
    sessionValid: true,
    knowledgeReady: true,
    webReady: true,
  });
  const checked = directory.listAccounts({ includeEvents: true })[0];
  assert.equal(checked.health.status, 'ready');
  assert.equal(checked.health.last_check_code, 'ok');
  assert.equal(checked.events.at(-1).meta.code, 'ok');
  assert.equal(JSON.stringify(checked).includes('token-health'), false);
  assert.equal(JSON.stringify(checked).includes('refresh-health'), false);

  directory.recordAccountHealth('account-health', {
    operation: 'check',
    code: 'knowledge_base_unavailable',
    sessionValid: false,
    knowledgeReady: false,
    webReady: true,
  });
  const unavailable = directory.listAccounts()[0];
  assert.equal(unavailable.health.status, 'unavailable');
  assert.equal(unavailable.health.knowledge_ready, false);
});

test('WebAgentAccountDirectory does not create a plaintext runtime export by default', () => {
  const tempDir = makeTempDirectory();
  const directory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });

  directory.upsertCapturedAccount({
    id: 'account-c',
    name: 'Account C',
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=user-3; IMA-TOKEN=token-c; IMA-REFRESH-TOKEN=refresh-c',
      'x-ima-bkn': '789',
    },
  });

  assert.equal(fs.existsSync(path.join(tempDir, 'web-agent-accounts', 'account-c.env')), false);
  assert.equal(directory.getAccount('account-c').runtimeEnvPath, '');
});

test('WebAgentAccountDirectory rejects duplicate normalized account IDs unless replace is explicit', () => {
  const tempDir = makeTempDirectory();
  const directory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });
  const headers = {
    'x-ima-cookie': 'IMA-UID=user-5; IMA-TOKEN=token-e; IMA-REFRESH-TOKEN=refresh-e',
    'x-ima-bkn': '234',
  };

  directory.upsertCapturedAccount({
    id: 'account-e',
    name: 'Account E',
    knowledgeBaseId: 'web-kb-id',
    headers,
  });
  assert.throws(
    () => directory.upsertCapturedAccount({
      id: 'ACCOUNT-E',
      name: 'Account-E',
      knowledgeBaseId: 'web-kb-id',
      headers,
    }),
    /已存在.*replace/,
  );
  assert.doesNotThrow(() => directory.upsertCapturedAccount({
    id: 'ACCOUNT-E',
    name: 'Account-E',
    knowledgeBaseId: 'web-kb-id',
    headers,
    replace: true,
  }));
});

test('WebAgentAccountDirectory re-login preserves a slot and rejects a different IMA identity', () => {
  const tempDir = makeTempDirectory();
  const directory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });
  directory.upsertCapturedAccount({
    id: 'account-e',
    name: 'Account E',
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=user-e; IMA-TOKEN=old-token; IMA-REFRESH-TOKEN=old-refresh',
      'x-ima-bkn': '234',
    },
  });

  assert.throws(() => directory.replaceCapturedAccount('account-e', {
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=different-user; IMA-TOKEN=new-token; IMA-REFRESH-TOKEN=new-refresh',
      'x-ima-bkn': '345',
    },
  }), (error) => error.code === 'ima_identity_mismatch' && error.statusCode === 409);
  assert.equal(directory.listAccounts().length, 1);

  assert.doesNotThrow(() => directory.replaceCapturedAccount('account-e', {
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=user-e; IMA-TOKEN=new-token; IMA-REFRESH-TOKEN=new-refresh',
      'x-ima-bkn': '345',
    },
  }));
  assert.equal(directory.listAccounts()[0].name, 'Account E');
});

test('WebAgentAccountDirectory rejects the same IMA identity under a new account name', () => {
  const tempDir = makeTempDirectory();
  const directory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });
  const headers = {
    'x-ima-cookie': 'IMA-UID=same-ima-user; IMA-TOKEN=token-a; IMA-REFRESH-TOKEN=refresh-a',
    'x-ima-bkn': '123',
  };

  directory.upsertCapturedAccount({
    id: 'account-primary',
    name: 'Account Primary',
    knowledgeBaseId: 'web-kb-id',
    headers,
  });

  assert.throws(
    () => directory.upsertCapturedAccount({
      id: 'account-renamed',
      name: 'Account Renamed',
      knowledgeBaseId: 'web-kb-id',
      headers: {
        ...headers,
        'x-ima-cookie': 'IMA-UID=same-ima-user; IMA-TOKEN=token-b; IMA-REFRESH-TOKEN=refresh-b',
      },
    }),
    (error) => error.code === 'duplicate_ima_identity' && error.statusCode === 409,
  );
  assert.equal(directory.listAccounts().length, 1);
});

test('WebAgentAccountDirectory disables duplicate legacy identities during migration', () => {
  const tempDir = makeTempDirectory();
  const storePath = path.join(tempDir, 'accounts.json');
  const keyPath = path.join(tempDir, 'accounts.key');
  const directory = new WebAgentAccountDirectory({ storePath, keyPath });
  directory.upsertCapturedAccount({
    id: 'account-original',
    name: 'Account Original',
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=legacy-same-user; IMA-TOKEN=token-a; IMA-REFRESH-TOKEN=refresh-a',
      'x-ima-bkn': '123',
    },
  });

  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const duplicate = JSON.parse(JSON.stringify(parsed.accounts[0]));
  duplicate.id = 'account-duplicate';
  duplicate.name = 'Account Duplicate';
  duplicate.principalFingerprint = '';
  duplicate.runtime.disabled = false;
  duplicate.runtime.disabledReason = '';
  parsed.accounts.push(duplicate);
  fs.writeFileSync(storePath, JSON.stringify(parsed), { mode: 0o600 });

  const migrated = new WebAgentAccountDirectory({ storePath, keyPath });
  const accounts = migrated.listAccounts();
  assert.equal(accounts.find((account) => account.id === 'account-original').status, 'available');
  assert.equal(accounts.find((account) => account.id === 'account-duplicate').status, 'disabled');
  assert.equal(accounts.find((account) => account.id === 'account-duplicate').identityDuplicate, true);
  assert.equal(migrated.getPoolAccounts().find((account) => account.id === 'account-duplicate').disabled, true);
  assert.throws(() => migrated.setDisabled('account-duplicate', false), /同一个 IMA 账号/);
});

test('WebAgentAccountDirectory removes managed legacy runtime exports with an account', () => {
  const tempDir = makeTempDirectory();
  const runtimeEnvPath = path.join(tempDir, 'web-agent-accounts', 'account-d.env');
  const directory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });

  directory.upsertCapturedAccount({
    id: 'account-d',
    name: 'Account D',
    knowledgeBaseId: 'web-kb-id',
    runtimeEnvPath,
    headers: {
      'x-ima-cookie': 'IMA-UID=user-4; IMA-TOKEN=token-d; IMA-REFRESH-TOKEN=refresh-d',
      'x-ima-bkn': '012',
    },
  });
  assert.equal(fs.existsSync(runtimeEnvPath), true);

  directory.deleteAccount('account-d');
  assert.equal(fs.existsSync(runtimeEnvPath), false);
});

test('WebAgentAccountDirectory can seal legacy runtime exports without losing encrypted credentials', () => {
  const tempDir = makeTempDirectory();
  const runtimeEnvPath = path.join(tempDir, 'web-agent-accounts', 'account-f.env');
  const directory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });

  directory.upsertCapturedAccount({
    id: 'account-f',
    name: 'Account F',
    knowledgeBaseId: 'web-kb-id',
    runtimeEnvPath,
    headers: {
      'x-ima-cookie': 'IMA-UID=user-6; IMA-TOKEN=token-f; IMA-REFRESH-TOKEN=refresh-f',
      'x-ima-bkn': '567',
    },
  });

  const result = directory.disableRuntimeEnvExport('account-f');
  assert.equal(result.account.runtimeEnvPath, '');
  assert.equal(result.removedManagedRuntimeEnv, true);
  assert.equal(fs.existsSync(runtimeEnvPath), false);
  assert.equal(directory.getPoolAccounts()[0].headers['x-ima-cookie'].includes('IMA-TOKEN=token-f'), true);
});
