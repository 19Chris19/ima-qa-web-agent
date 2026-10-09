'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyImaClientIdentityToAccountDirectory,
  extractImaClientIdentity,
  mergeImaClientIdentity,
  observeImaClientIdentity,
  summarizeImaClientIdentity,
} = require('../src/air/ima-client-identity');

const completeCookie = [
  'IMA-UID=synthetic-user',
  'IMA-TOKEN=synthetic-token',
  'IMA-REFRESH-TOKEN=synthetic-refresh',
  'IMA-GUID=synthetic-guid',
  'IMA-Q36=synthetic-q36',
  'IMA-IUA=synthetic-iua',
  'PLATFORM=H5',
  'CLIENT-TYPE=Normal',
  'WEB-VERSION=999.999.999',
].join('; ');

test('IMA client identity extracts only the official allowlisted device carrier', () => {
  const identity = extractImaClientIdentity(completeCookie);

  assert.deepEqual(Object.keys(identity).sort(), [
    'CLIENT-TYPE',
    'IMA-GUID',
    'IMA-IUA',
    'IMA-Q36',
    'PLATFORM',
    'WEB-VERSION',
  ]);
  assert.equal(JSON.stringify(identity).includes('synthetic-token'), false);
  assert.deepEqual(summarizeImaClientIdentity(identity), {
    schema_version: 'ima.client-identity.summary.v1',
    complete: true,
    field_count: 6,
  });
});

test('IMA client identity merge preserves account credentials without inventing fields', () => {
  const base = 'IMA-UID=synthetic-user; IMA-TOKEN=synthetic-token; IMA-REFRESH-TOKEN=synthetic-refresh';
  const identity = extractImaClientIdentity(completeCookie);
  const merged = mergeImaClientIdentity(base, identity);

  assert.match(merged, /IMA-TOKEN=synthetic-token/u);
  assert.match(merged, /IMA-GUID=synthetic-guid/u);
  assert.equal(summarizeImaClientIdentity(extractImaClientIdentity(merged)).complete, true);
  assert.throws(
    () => mergeImaClientIdentity(base, { ...identity, 'IMA-Q36': '' }),
    /ima_client_identity_incomplete/u,
  );
});

test('IMA client identity observer retains only a complete official request carrier', () => {
  const listeners = new Map();
  const context = {
    on(name, handler) { listeners.set(name, handler); },
    off(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
  };
  const observer = observeImaClientIdentity(context);
  listeners.get('request')({
    url: () => 'https://ima.qq.com/cgi-bin/account/info',
    headers: () => ({ 'x-ima-cookie': completeCookie }),
  });

  assert.equal(summarizeImaClientIdentity(observer.snapshot()).complete, true);
  assert.equal(JSON.stringify(observer.snapshot()).includes('synthetic-token'), false);
  observer.close();
  assert.equal(listeners.size, 0);
});

test('IMA client identity updates encrypted account carriers without returning identity data', () => {
  const calls = [];
  const directory = {
    getPoolAccounts() {
      return [{
        id: 'synthetic-account',
        headers: {
          'x-ima-cookie': 'IMA-UID=user; IMA-TOKEN=token; IMA-REFRESH-TOKEN=refresh',
          'x-ima-bkn': '123',
        },
      }];
    },
    updateCredentialsFromClient(id, snapshot) { calls.push({ id, snapshot }); },
  };

  const result = applyImaClientIdentityToAccountDirectory(
    directory,
    extractImaClientIdentity(completeCookie),
  );

  assert.deepEqual(result, { updated_accounts: 1 });
  assert.equal(calls[0].id, 'synthetic-account');
  assert.match(calls[0].snapshot.headers['x-ima-cookie'], /IMA-GUID=synthetic-guid/u);
});
