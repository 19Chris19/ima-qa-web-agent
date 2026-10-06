function capability(value) {
  return { state: value === true ? 'ready' : value === false ? 'unavailable' : 'unknown' };
}

function accountManagementView(account, poolAccount, readiness) {
  const auth = poolAccount?.auth;
  const health = account.health || {};
  const qualified = readiness?.qualified === true;
  const knowledgeState = readiness?.state || 'pending';
  return {
    knowledge: {
      state: !qualified && ['ready', 'busy', 'cooling'].includes(knowledgeState) ? 'pending' : knowledgeState,
      qualified,
      verifiedAt: qualified ? readiness?.verifiedAt || null : null,
    },
    // Session/knowledge health is not an independent generic web-search proof.
    web: capability(undefined),
    session: capability(health.session_valid),
    schedulable: readiness?.schedulable === true,
    maintenance: {
      state: auth?.maintenance?.state || 'unobserved',
      nextCheckAt: auth?.maintenance?.nextCheckAt || null,
      nextRetryAt: auth?.maintenance?.nextRetryAt || null,
      lastCheckAt: auth?.maintenance?.lastCheckAt || null,
      refreshEligibleAt: auth?.maintenance?.refreshEligibleAt || null,
      expiryKnown: Boolean(auth ? auth.tokenExpiresAt : account.tokenExpiresAt),
      tokenExpiresAt: auth ? auth.tokenExpiresAt : account.tokenExpiresAt || null,
      refreshTokenExpiresAt: auth ? auth.refreshTokenExpiresAt : account.refreshTokenExpiresAt || null,
      lastSuccessfulRefreshAt: auth?.lastRefreshAt ||
        (health.last_refresh_code === 'ok' ? health.last_refresh_at : null),
    },
  };
}

module.exports = { accountManagementView };
