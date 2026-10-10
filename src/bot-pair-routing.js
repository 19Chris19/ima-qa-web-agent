'use strict';

const crypto = require('node:crypto');

function botRoutingOptions(contract, applicationKey, ownerKey) {
  if (!contract) return {};
  const binding = contract.recentContextBinding;
  const pairScope = binding ? ['context', binding.account_id, binding.group_id, binding.route_ref,
    binding.route_generation, binding.feature_generation] : ['owner', ownerKey];
  return { retrievalPolicy: contract.retrievalPolicy, knowledgeScopeRef: contract.knowledgeScopeRef,
    recentContextRef: contract.recentContextRef, parallelPairRef: contract.parallelPairRef,
    parallelLeg: contract.parallelLeg,
    ...(contract.parallelPairRef ? { parallelPairKey: crypto.createHash('sha256')
      .update(JSON.stringify([applicationKey, pairScope, contract.parallelPairRef])).digest('hex') } : {}) };
}

function pairReceipt(task) {
  const routing = botRoutingOptions(task.input.botContract, task.applicationKey || task.scope, task.ownerKey);
  if (!routing.parallelPairKey) return task.pairReceipt;
  return { parallelPairKey: routing.parallelPairKey, parallelPairRef: routing.parallelPairRef,
    parallelLeg: routing.parallelLeg, retrievalPolicy: routing.retrievalPolicy,
    ...(task.pairReceipt?.accountId ? { accountId: task.pairReceipt.accountId } : {}) };
}

function validPairReceipt(receipt) {
  return receipt && Object.keys(receipt).every(key => ['parallelPairKey', 'parallelPairRef',
    'parallelLeg', 'retrievalPolicy', 'accountId'].includes(key)) &&
    [receipt.parallelPairKey, receipt.parallelPairRef].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)) &&
    ['knowledge', 'web'].includes(receipt.parallelLeg) &&
    receipt.retrievalPolicy === (receipt.parallelLeg === 'knowledge' ? 'group_knowledge' : 'web') &&
    (receipt.accountId === undefined || (typeof receipt.accountId === 'string' && receipt.accountId.length > 0));
}

module.exports = { botRoutingOptions, pairReceipt, validPairReceipt };
