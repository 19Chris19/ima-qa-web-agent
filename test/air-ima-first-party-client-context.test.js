'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  IMAFirstPartyClientContextProvider,
  normalizeFirstPartyClientContext,
} = require('../src/air/ima-first-party-client-context');

const identity = Object.freeze({
  'IMA-GUID': 'synthetic-guid',
  'IMA-Q36': 'synthetic-q36',
  'IMA-IUA': 'SyntheticAgent/1.0 (Device, Test)',
  PLATFORM: 'H5',
  'CLIENT-TYPE': '256052',
  'WEB-VERSION': '999.999.999',
});

const userAgent = 'SyntheticAgent/1.0 (Device; Test)';

test('first-party client context accepts only the explicit identity and device signer fields', () => {
  const context = normalizeFirstPartyClientContext({
    identity,
    userAgent,
    deviceInfo: {
      uskey: 'synthetic\u0001uskey',
      uskey_bus_infos_input: 'synthetic-bus-input',
      ignored: 'synthetic-extra',
    },
    ignored: 'synthetic-extra',
  });
  assert.deepEqual(context, {
    identity,
    userAgent,
    deviceInfo: {
      uskey: 'synthetic\u0001uskey',
      uskey_bus_infos_input: 'synthetic-bus-input',
    },
  });
  assert.throws(
    () => normalizeFirstPartyClientContext({ identity, deviceInfo: {} }),
    /ima_client_context_invalid/,
  );
  assert.throws(
    () => normalizeFirstPartyClientContext({
      identity,
      userAgent: 'MismatchedAgent/1.0',
      deviceInfo: {
        uskey: 'synthetic-uskey',
        uskey_bus_infos_input: 'synthetic-bus-input',
      },
    }),
    /ima_client_context_invalid/,
  );
});

test('first-party client context shares one refresh and expires it without exposing values', async () => {
  let now = 1_000;
  let calls = 0;
  const provider = new IMAFirstPartyClientContextProvider({
    now: () => now,
    maxAgeMs: 1_000,
    capture: async () => {
      calls += 1;
      return {
        identity,
        userAgent,
        deviceInfo: {
          uskey: `synthetic-uskey-${calls}`,
          uskey_bus_infos_input: `synthetic-bus-${calls}`,
        },
      };
    },
  });
  const [first, same] = await Promise.all([provider.get({}), provider.get({})]);
  assert.equal(calls, 1);
  assert.equal(first, same);
  assert.deepEqual(provider.summary(), {
    schema_version: 'ima.first-party-client-context.summary.v1',
    ready: true,
    refreshing: false,
  });
  now += 1_001;
  const refreshed = await provider.get({});
  assert.equal(calls, 2);
  assert.notEqual(refreshed.deviceInfo.uskey, first.deviceInfo.uskey);
  assert.equal(JSON.stringify(provider.summary()).includes('synthetic-uskey'), false);
});

test('first-party context cache is account and credential scoped, with pre-abort rejection', async () => {
  let calls = 0;
  const provider = new IMAFirstPartyClientContextProvider({ capture: async () => {
    calls++;
    return { identity, userAgent, deviceInfo: { uskey: `synthetic-${calls}`, uskey_bus_infos_input: 'synthetic' } };
  } });
  const one = await provider.get({ id: 'one', headers: { synthetic: 'first' } });
  const two = await provider.get({ id: 'two', headers: { synthetic: 'first' } });
  assert.notEqual(one, two);
  assert.equal(await provider.get({ id: 'one', headers: { synthetic: 'first' } }), one);
  assert.notEqual(await provider.get({ id: 'one', headers: { synthetic: 'rotated' } }), one);
  await assert.rejects(provider.get({ id: 'three' }, { signal: AbortSignal.abort() }));
  assert.equal(calls, 3);
});
