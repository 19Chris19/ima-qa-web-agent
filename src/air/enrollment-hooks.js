'use strict';

function createAirEnrollmentHooks(manager) {
  const runs = new Map();
  return {
    async onEnrolled(accountId) {
      try {
        const run = await manager.startForAccount(accountId, { mode: 'basic', confirm: true,
          authorizedRequestCount: 1, activateEnrollment: true,
          onStarted: started => runs.set(accountId, started.id) });
        const report = await manager.waitFor(run.runId);
        return { success: report?.status === 'succeeded', commitApplied: report?.commitApplied === true,
          warning: report?.warnings?.[0] || '', code: report?.failureCategory || 'ok' };
      } finally { runs.delete(accountId); }
    },
    onCancelVerification(accountId) {
      const runId = runs.get(accountId);
      if (runId) manager.cancel(runId);
    },
  };
}

module.exports = { createAirEnrollmentHooks };
