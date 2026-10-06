function capability(value) {
  return { state: value === true ? 'ready' : value === false ? 'unavailable' : 'unknown' };
}

function accountManagementView(account, poolAccount, readiness) {
  const auth = poolAccount?.auth;
  const health = account.health || {};
  return {
    knowledge: {
      state: readiness?.state || 'pending',
      qualified: readiness?.qualified === true,
      verifiedAt: readiness?.verifiedAt || null,
    },
    web: capability(health.web_ready),
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
