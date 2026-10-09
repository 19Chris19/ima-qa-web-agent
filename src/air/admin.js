'use strict';

const { createAdminAuthMiddleware } = require('../admin-routes');
const { buildAirEligibilityContract } = require('./admin-eligibility');

function registerAirAdminRoutes(app, { config, accountDirectory, manager, policies, sync = () => {} }) {
  const auth = createAdminAuthMiddleware(config.security?.adminToken);
  app.use('/api/admin/bootstrap', auth, (_req, res, next) => {
    const json = res.json.bind(res);
    res.json = body => json({ ...body, qualification: manager.getBootstrap(),
      enrollment: { ...body.enrollment,
        qualification: { required: true, automatic: true, requestsPerTarget: 1 } } });
    next();
  });
  const route = (method, path, fn) => app[method](path, auth, async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      const code = /^(qualification_|knowledge_agent_qualification_|provider_)[a-z_]+$/u.test(error.code || '')
        ? error.code : 'qualification_operation_failed';
      res.status(Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 400)
        .json({ success: false, code, error: code });
    }
  });
  route('get', '/api/admin/qualifications/bootstrap', (_req, res) => res.json({ success: true, qualification: manager.getBootstrap() }));
  route('get', '/api/admin/qualifications/active', (_req, res) => res.json({ success: true, run: manager.getActive() }));
  route('get', '/api/admin/qualifications/reports', (_req, res) => res.json({ success: true, reports: manager.listReports() }));
  route('get', '/api/admin/qualifications/reports/:reportId', (req, res) => res.json({ success: true, report: manager.getReport(req.params.reportId) }));
  route('post', '/api/admin/qualifications', async (req, res) => res.status(201).json({ success: true, run: await manager.start(req.body || {}) }));
  route('delete', '/api/admin/qualifications/:runId', (req, res) => {
    manager.cancel(req.params.runId); res.json({ success: true });
  });
  route('post', '/api/admin/accounts/:accountId/qualification', async (req, res) => {
    const account = accountDirectory.getAccount(req.params.accountId);
    if (!account || account.id !== req.params.accountId) return res.status(404).json({ success: false, code: 'qualification_account_invalid' });
    const mode = req.body?.mode === undefined ? 'basic' : req.body.mode;
    if (!['basic', 'advanced'].includes(mode)) {
      return res.status(400).json({ success: false, code: 'qualification_mode_invalid', error: 'qualification_mode_invalid' });
    }
    const activateEnrollment = account.runtime?.disabled === true &&
      (account.runtime.disabledReason === 'pending_enrollment_qualification' ||
        (mode === 'basic' && account.runtime.disabledReason === 'migration_verification_required'));
    res.status(202).json({ success: true, qualification: await manager.startForAccount(account.id, {
      confirm: req.body?.confirm === true, authorizedRequestCount: req.body?.authorizedRequestCount,
      candidateSetDigest: req.body?.candidateSetDigest, mode, activateEnrollment,
    }) });
  });
  route('get', '/api/admin/v2/accounts/eligibility', (_req, res) => res.json({ success: true, ...buildAirEligibilityContract({ accountDirectory, policies }) }));
  route('put', '/api/admin/accounts/:accountId/routing-lane', (req, res) => {
    if (manager.isMaintenanceActive()) throw Object.assign(new Error('provider_maintenance_conflict'), { code: 'provider_maintenance_conflict', statusCode: 409 });
    accountDirectory.setRoutingLane(req.params.accountId, req.body?.routingLane);
    sync(); res.json({ success: true, account: accountDirectory.listAccounts().find(row => row.id === req.params.accountId) });
  });
}

module.exports = { registerAirAdminRoutes };
