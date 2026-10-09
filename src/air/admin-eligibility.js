'use strict';

function buildAirEligibilityContract({ accountDirectory, policies }) {
  const poolSnapshot = policies?.eligibilitySnapshot?.() || null;
  const storedAccounts = accountDirectory.listAccounts();
  const storedById = new Map(storedAccounts.map((account) => [account.id, account]));
  const poolAccounts = new Map((poolSnapshot?.accounts || []).map((account) => [account.id, account]));
  const ids = new Set([...storedById.keys(), ...poolAccounts.keys()]);
  const accounts = [...ids].map((id) => {
    const stored = storedById.get(id) || null;
    const poolAccount = poolAccounts.get(id) || null;
    return {
      id,
      name: stored?.name || poolAccount?.name || '账号',
      routing_lane: poolAccount?.routing_lane || stored?.routingLane || 'flex',
      pool_synchronized: Boolean(stored && poolAccount),
      basic_health: stored?.health ? {
        check_status: healthCheckStatus(stored.health),
        local_schedulable: stored.health.local_schedulable,
        session_valid: stored.health.session_valid,
        refreshable: stored.health.refreshable,
        knowledge_ready: stored.health.knowledge_ready,
        web_ready: stored.health.web_ready,
        last_check_at: stored.health.last_check_at,
        last_check_code: stored.health.last_check_code,
      } : null,
      active_profile: poolAccount?.active_profile || {
        qualified: false,
        schedulable: false,
        available_now: false,
        reason_code: 'account_not_in_pool',
        proof_state: 'unknown',
        verified_at: null,
      },
      strategies: poolAccount?.strategies || {},
    };
  });
  const health = accounts.map((account) => account.basic_health);
  const strategyCounts = poolSnapshot?.summary?.strategies || {};
  return {
    schema_version: 'provider.a.admin.account-eligibility.v2',
    observed_at: poolSnapshot?.observed_at || new Date().toISOString(),
    active_profile: poolSnapshot?.active_profile || {
      name: '', generation: 0, ready: false, reason_code: 'profile_not_ready',
    },
    summary: {
      total_accounts: accounts.length,
      basic_healthy_accounts: health.filter((item) => item?.check_status === 'passed').length,
      refreshable_accounts: health.filter((item) => item?.refreshable === true).length,
      active_profile_capacity: Number(poolSnapshot?.summary?.active_profile_capacity || 0),
      active_profile_available_now: Number(poolSnapshot?.summary?.active_profile_available_now || 0),
      pending_active_profile_qualification: Number(poolSnapshot?.summary?.pending_active_profile_qualification || 0),
      active_profile_reason_counts: poolSnapshot?.summary?.active_profile_reason_counts || {},
      strategies: Object.fromEntries(['knowledge_agent', 'group_knowledge', 'auto', 'web', 'mixed'].map((policy) => [
        policy,
        {
          capacity: Number(strategyCounts[policy]?.capacity || 0),
          available_now: Number(strategyCounts[policy]?.available_now || 0),
        },
      ])),
    },
    accounts,
  };
}

function healthCheckStatus(health) {
  const results = [health.session_valid, health.knowledge_ready];
  if (results.every((value) => value === true)) return 'passed';
  if (results.some((value) => value === false)) return 'failed';
  return 'pending';
}

module.exports = { buildAirEligibilityContract };
