const { normalizeAccountId } = require('./web-agent-account-directory');
const {
  HEALTH_CODES,
  classifyAccountHealthError,
  healthMessage,
} = require('./account-health');

function registerAdminRoutes(app, options = {}) {
  const accountDirectory = options.accountDirectory;
  const enrollmentManager = options.enrollmentManager;
  const accountPoolExerciseManager = options.accountPoolExerciseManager;
  if (!accountDirectory) {
    return;
  }

  const auth = createAdminAuthMiddleware(options.config?.security?.adminToken);
  const sharedKnowledgeBaseId = String(options.config?.webAgent?.sharedKnowledgeBaseId || '').trim();
  const syncPool = () => {
    options.imaWebAgentClient?.syncAccounts?.(accountDirectory.getPoolAccounts());
    options.onAccountsSynced?.(options.imaWebAgentClient?.stats?.());
  };
  const managementSnapshot = (includeEvents = false) => buildManagementSnapshot({
    accountDirectory,
    pool: options.imaWebAgentClient,
    includeEvents,
  });
  const actionResponse = (accountId, operation, details = {}) => {
    const snapshot = managementSnapshot(true);
    return {
      success: true,
      operation: {
        type: operation,
        code: 'ok',
        message: details.message || healthMessage('ok'),
        completedAt: new Date().toISOString(),
      },
      ...snapshot,
      account: snapshot.accounts.find((account) => account.id === accountId) || null,
      consistency: verifyAccountConsistency({
        accountDirectory,
        pool: options.imaWebAgentClient,
        accountId,
        expected: details.expected || 'present',
      }),
    };
  };
  syncPool();

  app.get('/api/admin/accounts', auth, (req, res) => {
    res.json({
      success: true,
      ...managementSnapshot(wantsDetails(req)),
      queue: options.askQueue?.stats?.() || null,
    });
  });

  app.get('/api/admin/bootstrap', auth, (_req, res) => {
    res.json({
      success: true,
      provider: options.config?.qaProvider || 'ima-web-agent',
      sharedKnowledgeBaseId: sharedKnowledgeBaseId || null,
      enrollment: {
        requiresGuiMaintenanceMachine: true,
        accountStoreManagedByServer: true,
        supportsAdminPageQr: Boolean(enrollmentManager?.isAvailable?.()),
        timeoutSeconds: Math.round(Number(options.config?.webAgent?.enrollmentTimeoutMs || 0) / 1000) || 300,
        activeEnrollment: enrollmentManager?.getActive?.() || null,
      },
      exercise: accountPoolExerciseManager?.getBootstrap?.() || null,
    });
  });

  if (accountPoolExerciseManager) {
    app.get('/api/admin/exercises/templates', auth, (req, res) => {
      try {
        res.json({
          success: true,
          clients: accountPoolExerciseManager.getTemplates(req.query.count),
          exercise: accountPoolExerciseManager.getBootstrap(),
        });
      } catch (error) {
        sendAdminError(res, error);
      }
    });

    app.get('/api/admin/exercises/active', auth, (_req, res) => {
      res.json({ success: true, run: accountPoolExerciseManager.getActive() });
    });

    app.post('/api/admin/exercises', auth, async (req, res) => {
      try {
        const run = await accountPoolExerciseManager.start(req.body || {});
        res.status(201).json({ success: true, run });
      } catch (error) {
        sendAdminError(res, error);
      }
    });

    app.post('/api/admin/exercises/:runId/cancel', auth, (req, res) => {
      try {
        res.json({ success: true, run: accountPoolExerciseManager.cancel(req.params.runId) });
      } catch (error) {
        sendAdminError(res, error);
      }
    });

    app.get('/api/admin/exercises/reports', auth, (_req, res) => {
      res.json({ success: true, reports: accountPoolExerciseManager.listReports() });
    });

    app.get('/api/admin/exercises/reports/:reportId', auth, (req, res) => {
      try {
        res.json({ success: true, report: accountPoolExerciseManager.getReport(req.params.reportId) });
      } catch (error) {
        sendAdminError(res, error);
      }
    });

    app.get('/api/admin/exercises/reports/:reportId/export', auth, (req, res) => {
      try {
        const report = accountPoolExerciseManager.getReport(req.params.reportId);
        res.set({
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="ima-account-pool-exercise-${report.id}.json"`,
          'Cache-Control': 'no-store, private',
          'X-Content-Type-Options': 'nosniff',
        });
        res.json(report);
      } catch (error) {
        sendAdminError(res, error);
      }
    });

    app.put('/api/admin/exercises/reports/:reportId/reviews/:clientIndex', auth, (req, res) => {
      try {
        res.json({
          success: true,
          report: accountPoolExerciseManager.score(req.params.reportId, req.params.clientIndex, req.body || {}),
        });
      } catch (error) {
        sendAdminError(res, error);
      }
    });

    app.delete('/api/admin/exercises/reports/:reportId', auth, (req, res) => {
      try {
        accountPoolExerciseManager.deleteReport(req.params.reportId);
        res.json({ success: true });
      } catch (error) {
        sendAdminError(res, error);
      }
    });
  }

  if (enrollmentManager) {
    app.post('/api/admin/enrollments', auth, async (req, res) => {
      try {
        const enrollment = await enrollmentManager.start({
          name: req.body?.name,
          id: req.body?.id,
          reauthAccountId: req.body?.reauthAccountId,
          replace: Boolean(req.body?.replace),
        });
        res.status(201).json({ success: true, enrollment });
      } catch (error) {
        sendAdminError(res, error);
      }
    });

    app.get('/api/admin/enrollments/:enrollmentId/qr', auth, (req, res) => {
      try {
        const screenshot = enrollmentManager.getQr(req.params.enrollmentId);
        res.set({
          'Content-Type': enrollmentManager.getQrContentType?.(req.params.enrollmentId) || 'image/png',
          'Cache-Control': 'no-store, private',
          'X-Content-Type-Options': 'nosniff',
        });
        res.send(screenshot);
      } catch (error) {
        sendAdminError(res, error);
      }
    });

    app.get('/api/admin/enrollments/:enrollmentId', auth, (req, res) => {
      try {
        res.json({ success: true, enrollment: enrollmentManager.get(req.params.enrollmentId) });
      } catch (error) {
        sendAdminError(res, error);
      }
    });

    app.post('/api/admin/enrollments/:enrollmentId/focus-window', auth, async (req, res) => {
      try {
        const enrollment = await enrollmentManager.focusWindow(req.params.enrollmentId);
        res.json({ success: true, enrollment });
      } catch (error) {
        sendAdminError(res, error);
      }
    });

    app.delete('/api/admin/enrollments/:enrollmentId', auth, async (req, res) => {
      try {
        const enrollment = await enrollmentManager.cancel(req.params.enrollmentId);
        res.json({ success: true, enrollment });
      } catch (error) {
        sendAdminError(res, error);
      }
    });
  }

  app.post('/api/admin/accounts', auth, (req, res) => {
    try {
      rejectDuplicateAccount(accountDirectory, req.body, Boolean(req.body?.replace));
      const account = accountDirectory.upsertCapturedAccount({
        name: req.body?.name,
        id: req.body?.id,
        knowledgeBaseId: requireSharedKnowledgeBaseId(
          req.body?.knowledgeBaseId,
          sharedKnowledgeBaseId,
        ),
        headers: req.body?.headers,
        runtimeEnvPath: req.body?.runtimeEnvPath,
        modelId: req.body?.modelId,
        modelType: req.body?.modelType,
        tokenExpiresAt: req.body?.tokenExpiresAt,
        refreshTokenExpiresAt: req.body?.refreshTokenExpiresAt,
        source: req.body?.source || 'admin-api',
        replace: Boolean(req.body?.replace),
      });
      syncPool();
      res.json({ success: true, account });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  app.post('/api/admin/accounts/import-runtime', auth, (req, res) => {
    try {
      const runtimeEnvText = String(req.body?.runtimeEnvText || '');
      if (!runtimeEnvText || runtimeEnvText.length > 128 * 1024) {
        return res.status(400).json({ success: false, error: 'runtimeEnvText is required and must be under 128KB' });
      }
      rejectDuplicateAccount(accountDirectory, req.body, Boolean(req.body?.replace));
      const account = accountDirectory.upsertFromRuntimeEnv({
        name: req.body?.name,
        id: req.body?.id,
        knowledgeBaseId: requireSharedKnowledgeBaseId(
          req.body?.knowledgeBaseId,
          sharedKnowledgeBaseId,
        ),
        runtimeEnvText,
        runtimeEnvPath: req.body?.runtimeEnvPath,
        source: 'runtime-env-import',
        replace: Boolean(req.body?.replace),
      });
      syncPool();
      res.json({ success: true, account });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  app.post('/api/admin/accounts/:accountId/disable', auth, (req, res) => {
    try {
      accountDirectory.setDisabled(req.params.accountId, true, req.body?.reason);
      options.imaWebAgentClient?.setAccountDisabled?.(req.params.accountId, true, req.body?.reason);
      syncPool();
      res.json(actionResponse(req.params.accountId, 'disable', {
        message: '账号已停用，已从本机运行池移除',
        expected: 'disabled',
      }));
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  app.post('/api/admin/accounts/:accountId/enable', auth, (req, res) => {
    try {
      accountDirectory.setDisabled(req.params.accountId, false);
      options.imaWebAgentClient?.setAccountDisabled?.(req.params.accountId, false);
      syncPool();
      res.json(actionResponse(req.params.accountId, 'enable', {
        message: '账号已启用，已同步到本机运行池；请执行检查确认 IMA 会话可用',
        expected: 'enabled',
      }));
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  app.post('/api/admin/accounts/:accountId/refresh', auth, async (req, res) => {
    try {
      syncPool();
      const poolAccount = await options.imaWebAgentClient.refreshAccount(req.params.accountId);
      accountDirectory.recordAccountHealth(req.params.accountId, {
        operation: 'refresh',
        ...poolAccount.healthCheck,
      });
      syncPool();
      res.json(actionResponse(req.params.accountId, 'refresh', {
        message: '登录态已刷新并通过 IMA 会话检查',
        expected: 'present',
      }));
    } catch (error) {
      const code = recordAccountHealthFailure(accountDirectory, req.params.accountId, error, 'refresh');
      sendAdminError(res, error, code);
    }
  });

  app.post('/api/admin/accounts/:accountId/check', auth, async (req, res) => {
    try {
      syncPool();
      const poolAccount = await options.imaWebAgentClient.checkAccount(req.params.accountId);
      accountDirectory.recordAccountHealth(req.params.accountId, {
        operation: 'check',
        ...poolAccount.healthCheck,
      });
      res.json(actionResponse(req.params.accountId, 'check', {
        message: 'IMA 会话检查通过，未发送知识库问答',
        expected: 'present',
      }));
    } catch (error) {
      const code = recordAccountHealthFailure(accountDirectory, req.params.accountId, error, 'check');
      sendAdminError(res, error, code);
    }
  });

  app.post('/api/admin/accounts/:accountId/write-runtime', auth, (req, res) => {
    try {
      const runtimeEnvPath = accountDirectory.writeRuntimeEnvFile(req.params.accountId);
      res.json({ success: true, runtimeEnvPath });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  app.delete('/api/admin/accounts/:accountId', auth, (req, res) => {
    try {
      const deleted = accountDirectory.deleteAccount(req.params.accountId);
      syncPool();
      if (!deleted) {
        return res.status(404).json({ success: false, error: '账号不存在' });
      }
      res.json(actionResponse(req.params.accountId, 'delete', {
        message: '已删除本机账号记录和受管导出文件；未删除 IMA 云端账号',
        expected: 'absent',
      }));
    } catch (error) {
      sendAdminError(res, error);
    }
  });
}

function buildManagementSnapshot({ accountDirectory, pool, includeEvents = false }) {
  const directoryAccounts = accountDirectory.listAccounts({ includeEvents });
  const poolSummary = pool?.stats?.({ includeDetails: true }) || null;
  const poolAccounts = new Map((poolSummary?.accounts || []).map((account) => [account.id, account]));
  const accounts = directoryAccounts.map((account) => {
    const poolAccount = poolAccounts.get(account.id) || null;
    return {
      ...account,
      schedulerStatus: poolAccount?.status || 'unavailable',
      poolSynchronized: Boolean(poolAccount),
      availabilityStatus: account.health?.status || 'needs_check',
      maintenanceOperation: poolAccount?.maintenanceOperation || null,
    };
  });
  const summary = {
    totalAccounts: accounts.length,
    availableAccounts: accounts.filter((account) => account.availabilityStatus === 'ready').length,
    needsCheckAccounts: accounts.filter((account) => account.availabilityStatus === 'needs_check').length,
    unavailableAccounts: accounts.filter((account) => account.availabilityStatus === 'unavailable').length,
    busyAccounts: accounts.filter((account) => account.schedulerStatus === 'busy').length,
    coolingDownAccounts: accounts.filter((account) => account.schedulerStatus === 'cooling_down').length,
  };
  return { accounts, summary, pool: poolSummary };
}

function verifyAccountConsistency({ accountDirectory, pool, accountId, expected }) {
  const directoryAccount = accountDirectory.getAccount(accountId);
  const poolAccounts = pool?.stats?.({ includeDetails: true })?.accounts;
  const poolAccount = Array.isArray(poolAccounts)
    ? poolAccounts.find((account) => account.id === accountId)
    : null;
  const observed = Array.isArray(poolAccounts);
  let consistent = false;
  if (expected === 'absent') {
    consistent = observed && !directoryAccount && !poolAccount;
  } else if (expected === 'disabled') {
    consistent = observed && Boolean(directoryAccount?.runtime?.disabled) && poolAccount?.disabled === true;
  } else if (expected === 'enabled') {
    consistent = observed && !directoryAccount?.runtime?.disabled && poolAccount?.disabled === false;
  } else {
    consistent = observed && Boolean(directoryAccount) && Boolean(poolAccount);
  }
  return {
    directory: directoryAccount ? 'present' : 'absent',
    pool: observed ? (poolAccount ? 'present' : 'absent') : 'not_observable',
    consistent,
  };
}

function recordAccountHealthFailure(accountDirectory, accountId, error, operation) {
  const code = HEALTH_CODES[error?.code]
    ? error.code
    : classifyAccountHealthError(error, operation);
  if (code === 'account_operation_in_progress' || error?.statusCode === 404) {
    return code;
  }
  const outcome = { operation, code };
  if (code === 'auth_expired' || code === 'auth_rejected') {
    outcome.sessionValid = false;
    outcome.webReady = true;
  } else if (code === 'knowledge_base_unavailable') {
    outcome.sessionValid = false;
    outcome.knowledgeReady = false;
    outcome.webReady = true;
  } else if (code === 'web_context_missing') {
    outcome.webReady = false;
  }
  try {
    accountDirectory.recordAccountHealth(accountId, outcome);
  } catch {
    // Preserve the primary management error if its local audit update also fails.
  }
  return code;
}

function rejectDuplicateAccount(accountDirectory, input = {}, replace) {
  if (replace) {
    return;
  }
  const candidates = [input.id, input.name]
    .map((value) => normalizeAccountId(value))
    .filter(Boolean);
  const existing = accountDirectory.listAccounts().find((account) =>
    candidates.includes(normalizeAccountId(account.id)) || candidates.includes(normalizeAccountId(account.name)),
  );
  if (existing) {
    const error = new Error(`账号 ${existing.name} 已存在；如确认要重新绑定登录态，请显式使用 replace`);
    error.statusCode = 409;
    throw error;
  }
}

function requireSharedKnowledgeBaseId(candidate, configuredSharedKnowledgeBaseId) {
  const requested = String(candidate || '').trim();
  const configured = String(configuredSharedKnowledgeBaseId || '').trim();
  if (!configured) {
    return requested;
  }
  if (requested && requested !== configured) {
    const error = new Error('账号必须加入当前服务配置的同一个 IMA 共享知识库');
    error.statusCode = 409;
    throw error;
  }
  return configured;
}

function createAdminAuthMiddleware(expectedToken) {
  const token = String(expectedToken || '').trim();
  return function adminAuth(req, res, next) {
    if (!token && isLoopbackRequest(req) && isTrustedLocalAdminOrigin(req)) {
      next();
      return;
    }

    const header = String(req.headers.authorization || '');
    const supplied = header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : String(req.headers['x-ima-admin-token'] || '').trim();
    if (token && supplied === token) {
      next();
      return;
    }

    res.status(token ? 401 : 403).json({
      success: false,
      error: token ? '未授权的管理请求' : '管理接口未配置 token，仅允许本机访问',
    });
  };
}

function isTrustedLocalAdminOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) {
    // Local CLI tools do not send Origin. They are still limited to loopback above.
    return true;
  }
  try {
    const originUrl = new URL(origin);
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const requestHosts = [String(req.headers.host || '').trim(), forwardedHost].filter(Boolean);
    return requestHosts.includes(originUrl.host);
  } catch {
    return false;
  }
}

function isLoopbackRequest(req) {
  const values = [
    req.ip,
    req.socket?.remoteAddress,
    String(req.headers['x-forwarded-for'] || '').split(',')[0],
  ].filter(Boolean);
  return values.some((value) =>
    /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1|localhost)$/.test(String(value).trim()),
  );
}

function wantsDetails(req) {
  return ['1', 'true', 'yes'].includes(String(req.query.details || '').trim().toLowerCase());
}

function sendAdminError(res, error, fixedCode = '') {
  const code = fixedCode || (HEALTH_CODES[error?.code] ? error.code : '');
  res.status(error.statusCode || 400).json({
    success: false,
    code: code || undefined,
    error: code ? healthMessage(code) : safeAdminError(error),
  });
}

function safeAdminError(error) {
  return String(error?.message || error || '管理操作失败')
    .replace(/IMA-[A-Z-]+=[^;\s]+/g, 'IMA-SECRET=[redacted]')
    .replace(/"x-ima-cookie"\s*:\s*"[^"]+"/gi, '"x-ima-cookie":"[redacted]"')
    .replace(/"cookie"\s*:\s*"[^"]+"/gi, '"cookie":"[redacted]"')
    .slice(0, 240);
}

module.exports = {
  createAdminAuthMiddleware,
  isTrustedLocalAdminOrigin,
  rejectDuplicateAccount,
  requireSharedKnowledgeBaseId,
  registerAdminRoutes,
};
