function synchronizeProviderAQueueCapacity({ askQueue, config, pool, webReadiness }) {
  if (!askQueue?.setMaxConcurrent || !config?.concurrency?.autoScaleWithAccounts) {
    return askQueue?.stats?.() || null;
  }

  const poolStats = pool?.stats?.() || {};
  const eligibleSlots = webReadiness ? webReadiness.snapshot().capacity : Number.isFinite(poolStats.capacity) ? poolStats.capacity : Math.max(
    0,
    Number(poolStats.totalAccounts || 0) - Number(poolStats.unavailableAccounts || 0)
      - Number(poolStats.coolingDownAccounts || 0),
  );
  return askQueue.setMaxConcurrent(Math.max(0, eligibleSlots));
}

module.exports = {
  synchronizeProviderAQueueCapacity,
};
