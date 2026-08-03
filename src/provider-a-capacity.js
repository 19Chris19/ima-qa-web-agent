function synchronizeProviderAQueueCapacity({ askQueue, config, pool }) {
  if (!askQueue?.setMaxConcurrent || !config?.concurrency?.autoScaleWithAccounts) {
    return askQueue?.stats?.() || null;
  }

  const poolStats = pool?.stats?.() || {};
  const eligibleAccounts = Math.max(
    0,
    Number(poolStats.totalAccounts || 0) - Number(poolStats.unavailableAccounts || 0),
  );
  return askQueue.setMaxConcurrent(Math.max(1, eligibleAccounts));
}

module.exports = {
  synchronizeProviderAQueueCapacity,
};
