const { normalizeAccountId } = require('./web-agent-account-directory');

function registerAdminRoutes(app, options = {}) {
  const accountDirectory = options.accountDirectory;
  if (!accountDirectory) {
    return;
  }

  const auth = createAdminAuthMiddleware(options.config?.security?.adminToken);
  const sharedKnowledgeBaseId = String(options.config?.webAgent?.sharedKnowledgeBaseId || '').trim();
  const syncPool = () => {
    options.imaWebAgentClient?.syncAccounts?.(accountDirectory.getPoolAccounts());
    options.onAccountsSynced?.(options.imaWebAgentClient?.stats?.());
  };
  syncPool();

  app.get('/api/admin/accounts', auth, (req, res) => {
    res.json({
      success: true,
      accounts: accountDirectory.listAccounts({
        includeEvents: wantsDetails(req),
      }),
      pool: options.imaWebAgentClient?.stats?.({ includeDetails: wantsDetails(req) }) || null,
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
      },
    });
  });

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
      const account = accountDirectory.setDisabled(req.params.accountId, true, req.body?.reason);
      options.imaWebAgentClient?.setAccountDisabled?.(req.params.accountId, true, req.body?.reason);
      syncPool();
      res.json({ success: true, account });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  app.post('/api/admin/accounts/:accountId/enable', auth, (req, res) => {
    try {
      const account = accountDirectory.setDisabled(req.params.accountId, false);
      options.imaWebAgentClient?.setAccountDisabled?.(req.params.accountId, false);
      syncPool();
      res.json({ success: true, account });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  app.post('/api/admin/accounts/:accountId/refresh', auth, async (req, res) => {
    try {
      syncPool();
      const poolAccount = await options.imaWebAgentClient.refreshAccount(req.params.accountId);
      const account = accountDirectory.getAccount(req.params.accountId);
      res.json({
        success: true,
        account: account ? accountDirectory.listAccounts({ includeEvents: true }).find((item) => item.id === account.id) : null,
        poolAccount,
      });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  app.post('/api/admin/accounts/:accountId/check', auth, async (req, res) => {
    try {
      syncPool();
      const poolAccount = await options.imaWebAgentClient.checkAccount(req.params.accountId);
      accountDirectory.recordEvent(req.params.accountId, 'account_checked', 'Account knowledge session check passed');
      res.json({ success: true, poolAccount });
    } catch (error) {
      try {
        accountDirectory.recordEvent(req.params.accountId, 'account_check_failed', safeAdminError(error));
      } catch {
        // Ignore secondary logging failures.
      }
      sendAdminError(res, error);
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
      res.status(deleted ? 200 : 404).json({ success: deleted });
    } catch (error) {
      sendAdminError(res, error);
    }
  });
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

function sendAdminError(res, error) {
  res.status(error.statusCode || 400).json({
    success: false,
    error: safeAdminError(error),
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
