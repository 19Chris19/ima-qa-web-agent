const { POLICIES } = require('./bot-compat');

function providerAExecutionCapacity({ pool, webReadiness, airPolicyCapacity }) {
  if (pool?.persistenceReady?.() === false) return 0;
  if (airPolicyCapacity) {
    const website = webReadiness?.snapshot();
    const classicAccounts = new Set(website?.mode === 'classic_knowledge'
      ? website.accounts.filter(account => account.state !== 'needs_login').map(account => account.id) : []);
    const now = pool.now();
    const seen = new Set();
    // Policy capacities overlap. Count operational account slots, including busy
    // slots, once; individual reservations still enforce the requested policy.
    return cap(pool, airPolicyCapacity.accounts().reduce((sum, account) => {
      if (seen.has(account.id)) return sum;
      seen.add(account.id);
      if (account.disabled || account.maintenanceOperation || account.cooldownUntil > now) return sum;
      const slots = [];
      if (classicAccounts.has(account.id)) slots.push(pool.accountCapacity?.(account, { mode: 'classic_knowledge' }) ?? account.maxConcurrent);
      for (const policy of POLICIES) {
        if (!airPolicyCapacity.eligible(account, policy)
            || (policy === 'knowledge_agent' && pool.webReadiness && !pool.webReadiness(account))) continue;
        slots.push(pool.accountCapacity?.(account, { retrievalPolicy: policy }) ?? account.maxConcurrent);
      }
      return sum + Math.max(0, ...slots);
    }, 0));
  }

  const poolStats = pool?.stats?.() || {};
  return cap(pool, webReadiness ? webReadiness.snapshot().capacity : Number.isFinite(poolStats.capacity) ? poolStats.capacity : Math.max(
    0,
    Number(poolStats.totalAccounts || 0) - Number(poolStats.unavailableAccounts || 0)
      - Number(poolStats.coolingDownAccounts || 0),
  ));
}

function cap(pool, value) { return pool?.capCapacity?.(value) ?? value; }

function synchronizeProviderAQueueCapacity({ askQueue, config, pool, webReadiness, airPolicyCapacity }) {
  if (!askQueue?.setMaxConcurrent || !config?.concurrency?.autoScaleWithAccounts) {
    return askQueue?.stats?.() || null;
  }
  return askQueue.setMaxConcurrent(Math.max(0, providerAExecutionCapacity({ pool, webReadiness, airPolicyCapacity })));
}

module.exports = {
  providerAExecutionCapacity,
  synchronizeProviderAQueueCapacity,
};
