const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { IMAWebAgentClient, getBkn, stringifyCookie } = require('./ima-web-agent-client');
const { normalizeAccountId } = require('./web-agent-account-directory');

const DEFAULT_ENROLLMENT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SCREENSHOT_INTERVAL_MS = 900;
const IMA_NAVIGATION_TIMEOUT_MS = 15 * 1000;
const IMA_LOGIN_PROMPT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_EMBEDDED_QR_FALLBACK_MS = 20 * 1000;
const DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS = 75 * 1000;
const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 1500;
const JOB_RETENTION_MS = 60 * 1000;
const IMA_WEB_BASE_URL = 'https://ima.qq.com';
const SAFE_ENROLLMENT_STAGES = new Set([
  'launching_browser',
  'loading_ima',
  'opening_login',
  'waiting_for_qr',
  'waiting_for_scan',
  'browser_fallback',
  'verifying',
  'completed',
  'failed',
  'cancelled',
]);

class WebAgentEnrollmentManager {
  constructor(options = {}) {
    this.accountDirectory = options.accountDirectory;
    this.pool = options.pool;
    this.config = options.config || {};
    this.onAccountsSynced = options.onAccountsSynced || null;
    this.clientFactory = options.clientFactory || ((config) => new IMAWebAgentClient(config));
    this.browserLauncher = options.browserLauncher || launchVisibleBrowserContext;
    this.fetch = options.fetch || globalThis.fetch;
    this.captureAuth = options.captureAuth || captureAuthFromContext;
    this.now = options.now || Date.now;
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.browserCloseTimeoutMs = boundedPositiveNumber(
      options.browserCloseTimeoutMs,
      DEFAULT_BROWSER_CLOSE_TIMEOUT_MS,
    );
    this.jobs = new Map();
    this.activeJobId = '';
  }

  async start(options = {}) {
    if (!this.accountDirectory || !this.pool) {
      throw enrollmentError('当前服务未启用 Provider A 账号接入', 503);
    }
    if (!this.isAvailable()) {
      throw enrollmentError('当前服务未发现可用于二维码接入的本机浏览器，请配置 IMA_WEB_AGENT_BROWSER_PATH 或使用 CLI 接入', 503);
    }
    if (this.activeJobId) {
      throw enrollmentError('已有一个账号接入任务进行中，请先完成或取消它', 409);
    }

    const name = cleanAccountName(options.name);
    const id = normalizeAccountId(options.id || name);
    const knowledgeBaseId = String(
      options.knowledgeBaseId || this.config.webAgent?.sharedKnowledgeBaseId || '',
    ).trim();
    if (!knowledgeBaseId) {
      throw enrollmentError('服务尚未配置 IMA 共享知识库 ID', 503);
    }
    const existing = this.accountDirectory.listAccounts().find((account) =>
      normalizeAccountId(account.id) === id || normalizeAccountId(account.name) === normalizeAccountId(name),
    );
    if (existing && !options.replace) {
      throw enrollmentError(`账号 ${existing.name} 已存在；重新绑定需要明确选择替换`, 409);
    }

    const job = {
      id: this.idFactory(),
      name,
      accountId: id,
      knowledgeBaseId,
      replace: Boolean(options.replace),
      state: 'launching_browser',
      createdAt: this.now(),
      updatedAt: this.now(),
      expiresAt: this.now() + Number(options.timeoutMs || this.config.webAgent?.enrollmentTimeoutMs || DEFAULT_ENROLLMENT_TIMEOUT_MS),
      qr: null,
      context: null,
      page: null,
      browserControl: null,
      browserFlowStarted: false,
      awaitingBrowserConnection: false,
      qrModeConfirmed: false,
      userDataDir: '',
      launchPromise: null,
      monitorPromise: null,
      cleanupPromise: null,
      cleanupRequested: false,
      error: '',
      detail: '后台临时浏览器尚未启动',
      account: null,
      diagnostics: createEnrollmentDiagnostics(this.now()),
    };
    this.jobs.set(job.id, job);
    this.activeJobId = job.id;
    this._scheduleExpiry(job);

    job.launchPromise = this._launch(job)
      .catch((error) => this._fail(job, error));
    return this.get(job.id);
  }

  get(jobId) {
    const job = this.jobs.get(String(jobId || ''));
    if (!job) {
      throw enrollmentError('接入任务不存在或已过期', 404);
    }
    return publicJob(job);
  }

  getActive() {
    const job = this.jobs.get(this.activeJobId);
    return job ? publicJob(job) : null;
  }

  getQr(jobId) {
    const job = this.jobs.get(String(jobId || ''));
    if (!job) {
      throw enrollmentError('接入任务不存在或已过期', 404);
    }
    if (!job.qr || job.state !== 'waiting_for_scan') {
      throw enrollmentError('当前没有可展示的登录二维码', 409);
    }
    return Buffer.from(job.qr);
  }

  getQrContentType(jobId) {
    const screenshot = this.getQr(jobId);
    return detectQrImageContentType(screenshot) || 'image/png';
  }

  async focusWindow(jobId) {
    const job = this.jobs.get(String(jobId || ''));
    if (!job) {
      throw enrollmentError('接入任务不存在或已过期', 404);
    }
    if (!isPending(job) || (!job.page && !job.browserControl && !job.diagnostics?.browserFallbackAvailable)) {
      throw enrollmentError('当前接入任务没有可继续使用的受控登录窗口', 409);
    }
    if (job.browserControl?.visible === false) {
      if (job.relaunchPromise) {
        return publicJob(job, this.now());
      }
      job.detail = '正在打开可见的受控登录窗口作为二维码兜底';
      job.relaunchPromise = this._relaunchVisibleBrowser(job)
        .catch((error) => this._fail(job, error))
        .finally(() => {
          job.relaunchPromise = null;
        });
      return publicJob(job, this.now());
    }
    try {
      await job.browserControl?.focus?.();
      await job.page?.bringToFront?.();
      job.diagnostics.browserWindowAvailable = true;
      if (job.state === 'browser_fallback') {
        this._setState(job, 'browser_fallback', '已打开受控登录窗口，请在窗口内完成 IMA 扫码登录');
      } else {
        this._touch(job);
      }
      return publicJob(job, this.now());
    } catch {
      throw enrollmentError('无法将受控登录窗口切换到前台，请重新发起接入', 503, {
        code: 'browser_window_focus_failed',
        stage: job.state,
      });
    }
  }

  async cancel(jobId) {
    const job = this.jobs.get(String(jobId || ''));
    if (!job) {
      throw enrollmentError('接入任务不存在或已过期', 404);
    }
    if (['completed', 'failed', 'cancelled'].includes(job.state)) {
      return publicJob(job);
    }
    this._setState(job, 'cancelled', '已关闭临时浏览器并清理登录任务');
    job.error = '已取消账号接入';
    await this._cleanup(job);
    this._releaseActive(job);
    this._scheduleRemoval(job);
    return publicJob(job);
  }

  async shutdown() {
    await Promise.all([...this.jobs.values()].map((job) => this._cleanup(job)));
    this.jobs.clear();
    this.activeJobId = '';
  }

  isAvailable() {
    return Boolean(this.accountDirectory && this.pool && this._resolveBrowserPath());
  }

  async _launch(job, options = {}) {
    const browserPath = this._resolveBrowserPath();
    if (!browserPath) {
      throw enrollmentError('未找到可用浏览器，请配置 IMA_WEB_AGENT_BROWSER_PATH', 503);
    }
    this._setState(job, 'launching_browser', '正在启动独立的临时浏览器');
    job.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-qa-enrollment-'));
    const loginUrl = `${IMA_WEB_BASE_URL}/wikis?knowledgeBaseId=${encodeURIComponent(job.knowledgeBaseId)}&isUseKnowledgeBaseQa=1`;
    const browserMode = String(this.config.webAgent?.enrollmentBrowserMode || 'background');
    const headless = options.headless !== undefined ? Boolean(options.headless) : browserMode !== 'visible';
    const browserPromise = Promise.resolve().then(() => this.browserLauncher(job.userDataDir, {
      executablePath: browserPath,
      headless,
      viewport: { width: 1280, height: 860 },
      args: ['--no-first-run', '--no-default-browser-check'],
      initialUrl: loginUrl,
      connectionTimeoutMs: Math.max(1, job.expiresAt - this.now()),
    }, {
      onWindowOpened: (control) => this._registerBrowserWindow(job, control),
    }));
    const profileDirectory = job.userDataDir;
    const attachedContextPromise = browserPromise.then(async (context) => {
      if (job.cleanupRequested || ['completed', 'failed', 'cancelled'].includes(job.state)) {
        await this._closeBrowserContext(context, profileDirectory, job.browserControl)
          .finally(() => removeProfileDirectory(profileDirectory));
        return;
      }
      await this._attachBrowserContext(job, context);
      if (job.awaitingBrowserConnection && isPending(job)) {
        job.awaitingBrowserConnection = false;
        await this._continueBrowserFlow(job, loginUrl);
      }
    });
    try {
      await withTimeout(
        attachedContextPromise,
        boundedPositiveNumber(
          this.config.webAgent?.enrollmentBrowserLaunchTimeoutMs,
          DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS,
        ),
        enrollmentError('受控浏览器启动超时，请确认维护机允许启动 Chrome/Chromium 后重新发起接入', 503, {
          code: 'browser_launch_timeout',
          stage: 'launching_browser',
        }),
      );
    } catch (error) {
      if (String(error?.code || '') === 'browser_launch_timeout' && job.browserControl) {
        job.awaitingBrowserConnection = true;
        this._enableBrowserFallback(job, {
          code: 'browser_connection_timeout',
          stage: 'launching_browser',
          message: this._fallbackMessage(
            job,
            '受控登录窗口已打开，但服务尚未完成页面接管。请直接在该窗口完成扫码，服务会继续检测登录态并自动保存。',
            '后台登录浏览器已启动，但服务尚未完成页面接管。请在管理页继续等待二维码；若仍无法显示，可打开受控登录窗口继续扫码。',
          ),
        });
        return;
      }
      throw error;
    }
    await this._continueBrowserFlow(job, loginUrl);
  }

  async _relaunchVisibleBrowser(job) {
    const oldContext = job.context;
    const oldControl = job.browserControl;
    const oldProfileDirectory = job.userDataDir;
    job.context = null;
    job.page = null;
    job.browserControl = null;
    job.userDataDir = '';
    job.browserFlowStarted = false;
    job.qr = null;
    job.qrModeConfirmed = false;
    job.diagnostics.qrModeConfirmed = false;
    job.diagnostics.quickLoginGuardInstalled = false;
    job.diagnostics.browserWindowAvailable = false;
    await this._closeBrowserContext(oldContext, oldProfileDirectory, oldControl);
    removeProfileDirectory(oldProfileDirectory);
    if (!isPending(job)) {
      return;
    }
    await this._launch(job, { headless: false });
  }

  async _attachBrowserContext(job, context) {
    if (!context || !isPending(job)) {
      return;
    }
    job.context = context;
    job.page = job.context.pages?.()[0] || await job.context.newPage();
    try {
      await job.page.bringToFront?.();
    } catch {
      // The login window remains usable even when the window manager rejects focus.
    }
    job.diagnostics.browserWindowAvailable = job.browserControl
      ? job.browserControl.visible !== false
      : job.context?.__imaEnrollmentBrowserVisible !== false;
    this._touch(job);
  }

  async _continueBrowserFlow(job, loginUrl) {
    if (!isPending(job) || !job.page || job.browserFlowStarted) {
      return;
    }
    job.browserFlowStarted = true;
    job.diagnostics.quickLoginGuardInstalled = await installQuickLoginBlocker(job.page);
    this._touch(job);
    this._setState(job, 'loading_ima', '受控登录浏览器已打开，正在加载 IMA 登录页');
    try {
      await job.page.goto(loginUrl, { waitUntil: 'commit', timeout: IMA_NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      const diagnostic = describeEnrollmentFailure(error, 'loading_ima');
      this._enableBrowserFallback(job, {
        ...diagnostic,
        message: this._fallbackMessage(
          job,
          `${diagnostic.message} 已保留受控登录窗口；若页面稍后加载，可直接在窗口内完成扫码。`,
          `${diagnostic.message} 后台浏览器会继续尝试读取二维码；若仍无法显示，可打开受控登录窗口继续扫码。`,
        ),
      });
      this._ensureMonitor(job);
      return;
    }
    if (!isPending(job)) {
      return;
    }
    const loginPromptOpened = await this._openLoginPrompt(job);
    if (loginPromptOpened) {
      await this._waitForQr(job);
    }
    this._ensureMonitor(job);
  }

  async _openLoginPrompt(job) {
    if (!job.page) {
      return;
    }
    this._setState(job, 'opening_login', 'IMA 登录页已加载，正在打开扫码登录框');
    const deadline = Math.min(job.expiresAt, this.now() + IMA_LOGIN_PROMPT_TIMEOUT_MS);
    while (isPending(job) && this.now() < deadline) {
      if (await this._enforceQrOnlyMode(job)) {
        return true;
      }
      if (await clickImaLoginControl(job.page)) {
        // A click only opens the IMA modal. Do not treat it as an accepted login mode.
        if (typeof job.page.frames !== 'function') {
          this._confirmQrMode(job);
          return true;
        }
      }
      await this.sleep(300);
    }
    this._enableBrowserFallback(job, {
      code: 'login_control_timeout',
      stage: 'opening_login',
      message: this._fallbackMessage(
        job,
        'IMA 扫码登录框在等待时间内未就绪。服务不会使用快捷登录，已保留受控登录窗口供继续处理。',
        'IMA 扫码登录框在等待时间内未就绪。服务不会使用快捷登录；可打开受控登录窗口继续处理。',
      ),
    });
    return false;
  }

  async _waitForQr(job) {
    const intervalMs = Number(this.config.webAgent?.enrollmentScreenshotIntervalMs || DEFAULT_SCREENSHOT_INTERVAL_MS);
    this._setState(job, 'waiting_for_qr', '正在定位 IMA 的真实登录二维码');
    const fallbackAt = Math.min(
      job.expiresAt,
      this.now() + boundedPositiveNumber(
        this.config.webAgent?.enrollmentEmbeddedQrFallbackMs,
        DEFAULT_EMBEDDED_QR_FALLBACK_MS,
      ),
    );
    while (isPending(job)) {
      if (this.now() >= job.expiresAt) {
        throw enrollmentError('生成登录二维码超时，请检查 IMA 页面或重新发起接入', 408);
      }
      await this._enforceQrOnlyMode(job);
      const screenshot = job.qrModeConfirmed || typeof job.page?.frames !== 'function'
        ? await this._captureScreenshot(job)
        : null;
      if (screenshot) {
        this._clearRecoverableBrowserDiagnostic(job);
        this._setState(job, 'waiting_for_scan', '二维码已就绪，仅允许使用待接入账号的微信扫描下方二维码');
        return;
      }
      const switched = await switchToQrOnlyLoginMode(job.page);
      if (switched) {
        this._setState(job, 'waiting_for_qr', '正在切换到二维码登录方式');
      }
      if (this.now() >= fallbackAt) {
        this._enableBrowserFallback(job, {
          code: 'qr_frame_timeout',
          stage: 'waiting_for_qr',
          message: this._fallbackMessage(
            job,
            '未能在限定时间内读取微信二维码。服务不会改用快捷登录；受控登录窗口仍可继续扫码。',
            '未能在限定时间内读取微信二维码。服务不会改用快捷登录；可打开受控登录窗口继续扫码。',
          ),
        });
        return;
      }
      await this.sleep(intervalMs);
    }
  }

  async _monitor(job) {
    try {
      const intervalMs = Number(this.config.webAgent?.enrollmentScreenshotIntervalMs || DEFAULT_SCREENSHOT_INTERVAL_MS);
      while (isPending(job)) {
        if (this.now() >= job.expiresAt) {
          throw enrollmentError('二维码登录已超时，请重新发起接入', 408);
        }
        await this._enforceQrOnlyMode(job);
        const scanState = await detectImaScanState(job.page);
        if (scanState === 'scan_confirmed' && !job.diagnostics.scanDetected) {
          job.diagnostics.scanDetected = true;
          job.detail = '已收到微信扫码确认，正在等待 IMA 网页授权回调';
          this._touch(job);
        }
        const auth = await this.captureAuth(job.context);
        if (!isPending(job)) {
          return;
        }
        if (auth) {
          if (!job.qrModeConfirmed) {
            await this._fail(job, enrollmentError('检测到未经确认的登录态。为避免使用本机微信快捷登录，当前任务不会保存该账号。请重新发起接入并使用二维码扫描。', 409, {
              code: 'quick_login_blocked',
              stage: 'opening_login',
            }));
            return;
          }
          this._setState(job, 'verifying', '已检测到登录态，正在验证共享知识库访问权限');
          job.qr = null;
          const client = this.clientFactory({
            id: job.accountId,
            name: job.name,
            knowledgeBaseId: job.knowledgeBaseId,
            headers: auth.headers,
            modelId: this.config.webAgent?.modelId || 'official_3',
            modelType: this.config.webAgent?.modelType || 3,
          });
          await client.initSession();
          if (job.state !== 'verifying') {
            return;
          }
          job.account = this.accountDirectory.upsertCapturedAccount({
            id: job.accountId,
            name: job.name,
            knowledgeBaseId: job.knowledgeBaseId,
            headers: auth.headers,
            modelId: this.config.webAgent?.modelId || 'official_3',
            modelType: this.config.webAgent?.modelType || 3,
            tokenExpiresAt: auth.tokenExpiresAt,
            refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
            source: 'admin-qr-enrollment',
            replace: job.replace,
          });
          this.pool.syncAccounts(this.accountDirectory.getPoolAccounts());
          this.onAccountsSynced?.();
          this._setState(job, 'completed', '账号已验证并同步到账号池');
          await this._cleanup(job);
          this._releaseActive(job);
          this._scheduleRemoval(job);
          return;
        }
        if (job.diagnostics.scanDetected) {
          job.detail = '已收到微信扫码确认，正在等待 IMA 网页登录态同步；完成前不会新增账号';
          this._touch(job);
        }
        const screenshot = job.qrModeConfirmed || typeof job.page?.frames !== 'function'
          ? await this._captureScreenshot(job)
          : null;
        if (screenshot && job.state === 'browser_fallback') {
          this._clearRecoverableBrowserDiagnostic(job);
          this._setState(job, 'waiting_for_scan', '二维码已恢复可读取，请使用微信扫描下方二维码');
        }
        await this.sleep(intervalMs);
      }
    } catch (error) {
      if (job.state === 'cancelled') {
        return;
      }
      await this._fail(job, error);
    }
  }

  async _captureScreenshot(job) {
    if (!job.page || !isPending(job)) {
      return null;
    }
    try {
      const screenshot = await captureLoginScreenshot(job.page, { fetch: this.fetch });
      if (screenshot) {
        job.qr = screenshot;
        this._touch(job);
      }
      return screenshot;
    } catch (error) {
      if (!['completed', 'failed', 'cancelled'].includes(job.state)) {
        job.detail = 'IMA 登录页仍在加载，正在继续等待';
        this._recordDiagnostic(job, {
          code: 'qr_capture_retrying',
          stage: job.state,
          message: '微信二维码正在加载，服务会继续尝试读取。',
          retryable: true,
          fallbackAvailable: Boolean(job.diagnostics.browserWindowAvailable),
        });
        this._touch(job);
      }
      return null;
    }
  }

  async _fail(job, error) {
    if (['completed', 'cancelled'].includes(job.state)) {
      await this._cleanup(job);
      return;
    }
    const diagnostic = describeEnrollmentFailure(error, job.state);
    this._recordDiagnostic(job, diagnostic);
    this._setState(job, 'failed', diagnostic.message);
    job.qr = null;
    job.error = diagnostic.message;
    await this._cleanup(job);
    this._releaseActive(job);
    this._scheduleRemoval(job);
  }

  async _cleanup(job) {
    if (job.cleanupPromise) {
      return job.cleanupPromise;
    }
    job.cleanupPromise = (async () => {
      job.cleanupRequested = true;
      if (job.expiryTimer) {
        clearTimeout(job.expiryTimer);
        job.expiryTimer = null;
      }
      const profileDirectory = job.userDataDir;
      await this._closeBrowserContext(job.context, profileDirectory, job.browserControl);
      job.context = null;
      job.page = null;
      job.browserControl = null;
      job.qr = null;
      if (job.userDataDir) {
        removeProfileDirectory(job.userDataDir);
        job.userDataDir = '';
      }
    })();
    return job.cleanupPromise;
  }

  async _closeBrowserContext(context, profileDirectory, browserControl) {
    try {
      if (context?.close) {
        await withTimeout(
          Promise.resolve(context.close()),
          this.browserCloseTimeoutMs,
          new Error('controlled browser close timeout'),
        );
      }
    } catch {
      terminateBrowserProfile(profileDirectory);
    }
    try {
      await withTimeout(
        Promise.resolve(browserControl?.close?.()),
        this.browserCloseTimeoutMs,
        new Error('controlled browser close timeout'),
      );
    } catch {
      terminateBrowserProfile(profileDirectory);
    }
  }

  _registerBrowserWindow(job, control) {
    if (!control || job.cleanupRequested || ['completed', 'failed', 'cancelled'].includes(job.state)) {
      void control?.close?.();
      return;
    }
    job.browserControl = control;
    job.diagnostics.browserWindowAvailable = control.visible !== false;
    job.detail = '受控登录窗口已打开，正在建立安全连接';
    this._touch(job);
  }

  _ensureMonitor(job) {
    if (!job.context || job.monitorPromise || !isPending(job)) {
      return;
    }
    job.monitorPromise = this._monitor(job);
  }

  _confirmQrMode(job) {
    if (job.qrModeConfirmed) {
      return;
    }
    job.qrModeConfirmed = true;
    job.diagnostics.qrModeConfirmed = true;
    job.detail = '已确认微信扫码登录模式，不会使用本机微信快捷登录';
    this._touch(job);
  }

  async _enforceQrOnlyMode(job) {
    const loginMode = await currentImaLoginMode(job.page);
    if (loginMode === 'qr') {
      this._confirmQrMode(job);
      return true;
    }
    if (loginMode !== 'quick') {
      return false;
    }
    if (job.qrModeConfirmed) {
      throw enrollmentError('登录页已切换到快捷登录。为避免使用维护机上的微信账号，当前接入任务已停止，不会保存任何登录态。请重新生成二维码并只使用待接入账号扫码。', 409, {
        code: 'quick_login_blocked',
        stage: 'opening_login',
      });
    }
    const switched = await switchToQrOnlyLoginMode(job.page);
    job.detail = switched
      ? '已拦截快捷登录，正在切换到微信扫码登录'
      : '检测到快捷登录入口，服务正在等待二维码登录方式';
    this._touch(job);
    return false;
  }

  _scheduleExpiry(job) {
    const delay = Math.max(1, job.expiresAt - this.now());
    job.expiryTimer = setTimeout(() => {
      if (isPending(job)) {
        void this._fail(job, enrollmentError('二维码登录已超时，请重新发起接入', 408, {
          code: 'enrollment_expired',
          stage: job.state,
        }));
      }
    }, delay);
    job.expiryTimer.unref?.();
  }

  _releaseActive(job) {
    if (this.activeJobId === job.id) {
      this.activeJobId = '';
    }
  }

  _setState(job, state, detail) {
    if (['completed', 'failed', 'cancelled'].includes(job.state) && job.state !== state) {
      return;
    }
    const now = this.now();
    const previousStage = job.diagnostics?.currentStage;
    if (previousStage && previousStage !== state) {
      job.diagnostics.stageDurationsMs[previousStage] = Math.max(
        0,
        now - Number(job.diagnostics.stageStartedAt || now),
      );
    }
    job.state = state;
    job.detail = detail;
    if (job.diagnostics) {
      job.diagnostics.currentStage = state;
      job.diagnostics.stageStartedAt = now;
      job.diagnostics.browserFallbackAvailable = state === 'browser_fallback' ||
        Boolean(job.diagnostics.browserFallbackAvailable);
    }
    this._touch(job, now);
  }

  _touch(job, now = this.now()) {
    job.updatedAt = now;
  }

  _recordDiagnostic(job, diagnostic) {
    if (!job.diagnostics) {
      job.diagnostics = createEnrollmentDiagnostics(this.now());
    }
    job.diagnostics.lastFailure = {
      code: String(diagnostic.code || 'enrollment_failed'),
      stage: String(diagnostic.stage || job.state || 'unknown'),
      message: publicEnrollmentError(diagnostic.message || '账号接入失败'),
      retryable: diagnostic.retryable !== false,
      fallbackAvailable: Boolean(diagnostic.fallbackAvailable),
      occurredAt: this.now(),
    };
  }

  _clearRecoverableBrowserDiagnostic(job) {
    if (!job.diagnostics) {
      return;
    }
    if (['browser_connection_timeout', 'ima_navigation_timeout', 'qr_frame_timeout', 'qr_capture_retrying'].includes(
      String(job.diagnostics.lastFailure?.code || ''),
    )) {
      job.diagnostics.lastFailure = null;
    }
    job.diagnostics.browserFallbackAvailable = false;
  }

  _enableBrowserFallback(job, diagnostic) {
    job.diagnostics.browserFallbackAvailable = true;
    this._recordDiagnostic(job, {
      ...diagnostic,
      retryable: true,
      fallbackAvailable: true,
    });
    this._setState(job, 'browser_fallback', diagnostic.message);
  }

  _fallbackMessage(job, visibleMessage, backgroundMessage) {
    return job.browserControl?.visible === false ? backgroundMessage : visibleMessage;
  }

  _scheduleRemoval(job) {
    setTimeout(() => {
      if (this.jobs.get(job.id) === job) {
        this.jobs.delete(job.id);
      }
    }, JOB_RETENTION_MS).unref?.();
  }

  _resolveBrowserPath() {
    const candidates = [
      this.config.webAgent?.browserPath,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/ego lite.app/Contents/MacOS/ego lite',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ].map((value) => String(value || '').trim()).filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
  }
}

async function launchVisibleBrowserContext(userDataDir, launchOptions = {}, hooks = {}) {
  if (process.platform !== 'darwin') {
    return chromium.launchPersistentContext(userDataDir, launchOptions).then((context) => {
      context.__imaEnrollmentBrowserVisible = !launchOptions.headless;
      return context;
    });
  }

  const executablePath = String(launchOptions.executablePath || '').trim();
  if (!executablePath) {
    throw enrollmentError('未找到可用浏览器，请配置 IMA_WEB_AGENT_BROWSER_PATH', 503);
  }
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    ...Array.isArray(launchOptions.args) ? launchOptions.args : [],
    ...(launchOptions.headless ? ['--headless=new', '--window-size=1280,860'] : []),
    // Attach Playwright before IMA starts its login shell. On macOS Chrome,
    // loading a remote page during CDP startup can delay context discovery.
    'about:blank',
  ];
  const browserProcess = spawn(executablePath, args, { stdio: 'ignore' });
  const control = {
    browser: null,
    visible: !launchOptions.headless,
    exited: false,
    exitMessage: '',
    async focus() {
      const page = control.browser?.contexts?.()[0]?.pages?.()[0];
      await page?.bringToFront?.();
    },
    async close() {
      try {
        await control.browser?.close?.();
      } catch {
        // The process cleanup below handles disconnected CDP sessions.
      }
      try {
        browserProcess.kill('SIGTERM');
      } catch {
        // The browser can already have exited after successful authentication.
      }
      terminateBrowserProfile(userDataDir);
    },
  };
  browserProcess.once('error', (error) => {
    control.exited = true;
    control.exitMessage = String(error?.message || '受控浏览器无法启动');
  });
  browserProcess.once('exit', (code, signal) => {
    control.exited = true;
    control.exitMessage = `受控浏览器已退出（${signal || code || 'unknown'}）`;
  });
  hooks.onWindowOpened?.(control);

  const connectionTimeoutMs = boundedPositiveNumber(
    launchOptions.connectionTimeoutMs,
    DEFAULT_ENROLLMENT_TIMEOUT_MS,
  );
  const deadline = Date.now() + connectionTimeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (control.exited) {
      throw enrollmentError(control.exitMessage || '受控浏览器已退出', 503, {
        code: 'browser_process_exit',
        stage: 'launching_browser',
      });
    }
    try {
      const debuggerUrl = readDevToolsDebuggerUrl(userDataDir);
      if (!debuggerUrl) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      // Recent macOS Chrome versions can expose DevToolsActivePort before CDP is ready.
      // Give one owned browser enough time to finish its protocol initialization.
      const browser = await chromium.connectOverCDP(debuggerUrl, { timeout: 12 * 1000 });
      const context = browser.contexts()[0];
      if (context) {
        control.browser = browser;
        return context;
      }
      await browser.close().catch(() => {});
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw enrollmentError('受控浏览器已打开，但服务无法建立安全连接。可在窗口内继续登录后重新发起接入。', 503, {
    code: 'browser_connection_timeout',
    stage: 'launching_browser',
    cause: lastError,
  });
}

function readDevToolsDebuggerUrl(userDataDir) {
  try {
    const lines = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
    const port = Number(lines[0]);
    const browserPath = String(lines[1] || '');
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath.startsWith('/devtools/browser/')) {
      return '';
    }
    return `http://127.0.0.1:${port}`;
  } catch {
    return '';
  }
}

async function captureAuthFromContext(context) {
  const cookies = await context.cookies(IMA_WEB_BASE_URL);
  const cookieMap = Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value]));
  if (cookieMap['IMA-UID'] && cookieMap['IMA-TOKEN'] && cookieMap['IMA-REFRESH-TOKEN']) {
    return {
      headers: {
        'x-ima-cookie': stringifyCookie(cookieMap),
        'x-ima-bkn': String(getBkn(cookieMap['IMA-TOKEN'] || '')),
      },
      tokenExpiresAt: cookieExpiryMs(cookies, 'IMA-TOKEN'),
      refreshTokenExpiresAt: cookieExpiryMs(cookies, 'IMA-REFRESH-TOKEN'),
    };
  }
  for (const page of context.pages()) {
    const accountInfos = await readWebStorageAccountInfo(page);
    for (const accountInfo of accountInfos) {
      const auth = authFromAccountInfo(accountInfo);
      if (auth) {
        return auth;
      }
    }
  }
  return null;
}

async function readWebStorageAccountInfo(page) {
  try {
    return await page.evaluate(() => {
      const preferredKey = 'ima-universal-local-storage-accountInfo';
      const collect = (storage, scope) => {
        const keys = [preferredKey];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (!key || key === preferredKey) {
            continue;
          }
          const normalized = key.toLowerCase();
          const isImaCredentialKey = normalized.includes('ima') &&
            /(?:account|auth|session|user|token|login)/.test(normalized);
          const isCommonAccountKey = /^(?:accountinfo|userinfo|logininfo)$/.test(normalized);
          if (isImaCredentialKey || isCommonAccountKey) {
            keys.push(key);
          }
        }
        return keys.slice(0, 12).flatMap((key) => {
          const raw = storage.getItem(key);
          if (!raw || raw.length > 64 * 1024) {
            return [];
          }
          try {
            return [{ scope, key, value: JSON.parse(raw) }];
          } catch {
            return [];
          }
        });
      };
      return [
        ...collect(window.localStorage, 'local'),
        ...collect(window.sessionStorage, 'session'),
      ];
    });
  } catch {
    return [];
  }
}

function authFromAccountInfo(candidate) {
  const records = accountInfoRecords(candidate?.value ?? candidate);
  for (const accountInfo of records) {
    const token = firstText(accountInfo.token, accountInfo.accessToken, accountInfo.access_token);
    const refreshToken = firstText(accountInfo.refreshToken, accountInfo.refresh_token);
    const userId = firstText(
      accountInfo.userId,
      accountInfo.uid,
      accountInfo.user_id,
      accountInfo.user?.id,
      accountInfo.user?.userId,
    );
    if (!token || !refreshToken || !userId) {
      continue;
    }
    const cookieValues = {
      'IMA-UID': userId,
      'IMA-TOKEN': token,
      'IMA-REFRESH-TOKEN': refreshToken,
      'TOKEN-TYPE': String(firstText(accountInfo.tokenType, accountInfo.token_type) || 0),
      'UID-TYPE': String(firstText(accountInfo.idType, accountInfo.id_type) || '1'),
    };
    return {
      headers: {
        'x-ima-cookie': stringifyCookie(cookieValues),
        'x-ima-bkn': String(getBkn(token)),
      },
      tokenExpiresAt: positiveNumber(firstText(accountInfo.tokenExpiredTime, accountInfo.token_expires_at)),
      refreshTokenExpiresAt: positiveNumber(firstText(
        accountInfo.refreshTokenExpiredTime,
        accountInfo.refresh_token_expires_at,
      )),
    };
  }
  return null;
}

function accountInfoRecords(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2) {
    return [];
  }
  return [value, ...['data', 'account', 'accountInfo', 'payload', 'result']
    .flatMap((key) => accountInfoRecords(value[key], depth + 1))];
}

function firstText(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

async function captureLoginScreenshot(page, options = {}) {
  const frameScreenshot = await captureWeChatQrScreenshot(page, options.fetch || globalThis.fetch);
  if (frameScreenshot) {
    return frameScreenshot;
  }
  const clip = await findLikelyQrClip(page) || await findLikelyQrFrameClip(page);
  return clip ? page.screenshot({ type: 'png', clip }) : null;
}

async function captureWeChatQrScreenshot(page, fetchFn) {
  if (typeof page.frames !== 'function' || typeof fetchFn !== 'function') {
    return null;
  }
  for (const frame of page.frames()) {
    if (!/open\.weixin\.qq\.com\/connect\/(?:qrconnect|qrcode)/i.test(String(frame.url?.() || ''))) {
      continue;
    }
    try {
      const qrUrl = await frame.evaluate(() => [...document.images]
        .map((image) => String(image.currentSrc || image.src || ''))
        .find((src) => /^https:\/\/open\.weixin\.qq\.com\/connect\/qrcode\/[a-zA-Z0-9_-]+$/.test(src)) || '');
      if (isAllowedWeChatQrUrl(qrUrl)) {
        const response = await fetchFn(qrUrl, { redirect: 'manual' });
        const contentType = String(response?.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
        const contentLength = Number(response?.headers?.get?.('content-length') || 0);
        if (!response?.ok || !['image/jpeg', 'image/png'].includes(contentType) || contentLength > 1024 * 1024) {
          continue;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 0 && bytes.length <= 1024 * 1024 && detectQrImageContentType(bytes) === contentType) {
          return bytes;
        }
      }
    } catch {
      // The cross-origin login frame can be recreated while IMA changes login modes.
    }
  }
  return null;
}

function isAllowedWeChatQrUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'open.weixin.qq.com' &&
      /^\/connect\/qrcode\/[a-zA-Z0-9_-]+$/.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function detectQrImageContentType(bytes) {
  if (bytes?.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes?.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return '';
}

async function switchToWeChatQrMode(page) {
  if (typeof page?.frames !== 'function') {
    return false;
  }
  for (const frame of page.frames()) {
    if (!/open\.weixin\.qq\.com\/connect\/qrconnect/i.test(String(frame.url?.() || ''))) {
      continue;
    }
    try {
      const switches = frame.locator('button.web_qrcode_switch');
      const visibleIndex = await switches.evaluateAll((elements) => elements
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return {
            index,
            visible: style.display !== 'none' && style.visibility !== 'hidden' &&
              Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0,
          };
        })
        .find((candidate) => candidate.visible)?.index ?? null);
      if (visibleIndex !== null) {
        await switches.nth(visibleIndex).click({ timeout: 1500 });
        return true;
      }
    } catch {
      // The login provider has not rendered its mode switch yet.
    }
  }
  return false;
}

async function switchToQrOnlyLoginMode(page) {
  if (await switchToWeChatQrMode(page)) {
    return true;
  }
  const scopes = typeof page?.frames === 'function' ? page.frames() : [page];
  for (const scope of scopes) {
    if (typeof scope?.getByText !== 'function') {
      continue;
    }
    for (const label of ['扫码登录', '微信扫码登录', '二维码登录', '使用二维码登录']) {
      if (!isQrLoginActionText(label)) {
        continue;
      }
      try {
        await scope.getByText(label, { exact: true }).first().click({ timeout: 1200, force: true });
        return true;
      } catch {
        // The provider can recreate its modal while the login mode changes.
      }
    }
  }
  return false;
}

async function installQuickLoginBlocker(page) {
  if (!page) {
    return false;
  }
  let installed = false;
  try {
    if (typeof page.addInitScript === 'function') {
      await page.addInitScript(blockQuickLoginInDocument);
      installed = true;
    }
  } catch {
    // A page may already be navigating when the browser is first attached.
  }
  const scopes = typeof page.frames === 'function' ? page.frames() : [page];
  for (const scope of scopes) {
    try {
      if (typeof scope?.evaluate === 'function') {
        await scope.evaluate(blockQuickLoginInDocument);
        installed = true;
      }
    } catch {
      // The cross-origin login frame can be recreated while IMA changes login modes.
    }
  }
  return installed;
}

function blockQuickLoginInDocument() {
  if (window.__imaQaQuickLoginBlocked) {
    return;
  }
  window.__imaQaQuickLoginBlocked = true;
  const isQuickLogin = (element) => /^(?:快捷登录|一键登录|本机微信登录)$/.test(
    String(element?.textContent || '').replace(/\s+/g, ' ').trim(),
  );
  const block = (event) => {
    let element = event.target instanceof Element ? event.target : event.target?.parentElement;
    while (element && element !== document.body) {
      if (isQuickLogin(element)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      element = element.parentElement;
    }
  };
  document.addEventListener('click', block, true);
  document.addEventListener('auxclick', block, true);
}

async function currentImaLoginMode(page) {
  const scopes = typeof page?.frames === 'function' ? page.frames() : [page];
  const snippets = [];
  for (const scope of scopes) {
    try {
      const text = await scope.evaluate(() => String(document.body?.innerText || '').slice(0, 1600));
      if (typeof text === 'string') {
        snippets.push(text);
      }
    } catch {
      // A cross-origin frame may be in the middle of navigation.
    }
  }
  return classifyImaLoginMode(snippets.join('\n'));
}

async function detectImaScanState(page) {
  const scopes = typeof page?.frames === 'function' ? page.frames() : [page];
  const snippets = [];
  for (const scope of scopes) {
    try {
      const text = await scope.evaluate(() => String(document.body?.innerText || '').slice(0, 1600));
      if (typeof text === 'string') {
        snippets.push(text);
      }
    } catch {
      // A cross-origin login frame may be in the middle of navigation.
    }
  }
  return classifyImaScanState(snippets.join('\n'));
}

function classifyImaScanState(value) {
  const text = String(value || '').replace(/\s+/g, ' ');
  if (/(?:扫码成功|扫描成功|已扫码|已扫描|确认登录|正在登录|授权成功)/.test(text)) {
    return 'scan_confirmed';
  }
  return 'waiting';
}

function classifyImaLoginMode(value) {
  const text = String(value || '').replace(/\s+/g, ' ');
  if (/微信扫码登录|扫码登录|二维码登录|使用二维码登录/.test(text)) {
    return 'qr';
  }
  if (/快捷登录|一键登录|本机微信登录/.test(text)) {
    return 'quick';
  }
  return 'unknown';
}

function isQrLoginActionText(value) {
  return ['扫码登录', '微信扫码登录', '二维码登录', '使用二维码登录'].includes(String(value || '').trim());
}

async function findLikelyQrClip(page) {
  try {
    return await page.evaluate(() => {
      const isVisible = (element, rect) => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 &&
          rect.width >= 90 && rect.height >= 90;
      };
      const candidates = [...document.querySelectorAll('canvas, img')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const marker = `${element.id || ''} ${element.className || ''} ${element.getAttribute('alt') || ''} ${element.currentSrc || element.src || ''}`.toLowerCase();
          const squareDelta = Math.abs(rect.width - rect.height) / Math.max(rect.width, rect.height, 1);
          const score = (/(?:qr|qrcode|scan|扫码|登录码)/.test(marker) ? 20 : 0) +
            (element.tagName === 'CANVAS' ? 8 : 0) +
            (squareDelta < 0.18 ? 6 : 0) -
            Math.abs(Math.min(rect.width, rect.height) - 240) / 100;
          return { rect, score, visible: isVisible(element, rect), squareDelta };
        })
        .filter((candidate) => candidate.visible && candidate.squareDelta < 0.3)
        .sort((left, right) => right.score - left.score);
      const winner = candidates[0];
      if (!winner || winner.score < 5) {
        return null;
      }
      const padding = 18;
      return {
        x: Math.max(0, Math.floor(winner.rect.x - padding)),
        y: Math.max(0, Math.floor(winner.rect.y - padding)),
        width: Math.ceil(winner.rect.width + padding * 2),
        height: Math.ceil(winner.rect.height + padding * 2),
      };
    });
  } catch {
    return null;
  }
}

async function findLikelyQrFrameClip(page) {
  try {
    return await page.evaluate(() => {
      const visible = (element, rect) => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0 && rect.width >= 120 && rect.height >= 120;
      };
      const candidates = [...document.querySelectorAll('iframe')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const marker = `${element.id || ''} ${element.className || ''} ${element.title || ''} ${element.src || ''}`.toLowerCase();
          const score = (/(?:weixin|wechat|login|qr|qrcode|扫码)/.test(marker) ? 24 : 0) +
            (rect.width <= 640 && rect.height <= 640 ? 8 : 0) -
            Math.abs(Math.min(rect.width, rect.height) - 240) / 80;
          return { rect, score, visible: visible(element, rect) };
        })
        .filter((candidate) => candidate.visible)
        .sort((left, right) => right.score - left.score);
      const winner = candidates[0];
      if (!winner || winner.score < 8) {
        return null;
      }
      const padding = 8;
      return {
        x: Math.max(0, Math.floor(winner.rect.x - padding)),
        y: Math.max(0, Math.floor(winner.rect.y - padding)),
        width: Math.ceil(winner.rect.width + padding * 2),
        height: Math.ceil(winner.rect.height + padding * 2),
      };
    });
  } catch {
    return null;
  }
}

function publicJob(job, now = Date.now()) {
  const diagnostics = job.diagnostics || createEnrollmentDiagnostics(job.createdAt || now);
  const stageDurationsMs = { ...diagnostics.stageDurationsMs };
  if (diagnostics.currentStage) {
    stageDurationsMs[diagnostics.currentStage] = Math.max(
      0,
      now - Number(diagnostics.stageStartedAt || now),
    );
  }
  return {
    taskId: job.id,
    name: job.name,
    state: job.state,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt || job.createdAt).toISOString(),
    expiresAt: new Date(job.expiresAt).toISOString(),
    qrAvailable: Boolean(job.qr),
    detail: job.detail || null,
    error: job.error || null,
    diagnostics: {
      loginMode: 'qr_only',
      qrModeConfirmed: Boolean(diagnostics.qrModeConfirmed),
      quickLoginGuardInstalled: Boolean(diagnostics.quickLoginGuardInstalled),
      scanDetected: Boolean(diagnostics.scanDetected),
      currentStage: safeEnrollmentStage(diagnostics.currentStage || job.state),
      elapsedMs: Math.max(0, now - Number(job.createdAt || now)),
      stageDurationsMs: publicStageDurations(stageDurationsMs),
      browserWindowAvailable: Boolean(diagnostics.browserWindowAvailable && (job.page || job.browserControl)),
      browserFallbackAvailable: Boolean(diagnostics.browserFallbackAvailable && (job.page || job.browserControl)),
      lastFailure: diagnostics.lastFailure ? {
        code: diagnostics.lastFailure.code,
        stage: safeEnrollmentStage(diagnostics.lastFailure.stage),
        message: diagnostics.lastFailure.message,
        retryable: Boolean(diagnostics.lastFailure.retryable),
        fallbackAvailable: Boolean(diagnostics.lastFailure.fallbackAvailable && (job.page || job.browserControl)),
      } : null,
    },
    account: job.account ? {
      id: job.account.id,
      name: job.account.name,
      status: job.account.status,
      tokenExpiresAt: job.account.tokenExpiresAt,
      refreshTokenExpiresAt: job.account.refreshTokenExpiresAt,
    } : null,
  };
}

function isPending(job) {
  return ['launching_browser', 'loading_ima', 'opening_login', 'waiting_for_qr', 'waiting_for_scan', 'browser_fallback', 'verifying'].includes(job.state);
}

function enrollmentError(message, statusCode = 400, details = {}) {
  const error = new Error(String(message));
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function createEnrollmentDiagnostics(now) {
  return {
    currentStage: 'launching_browser',
    stageStartedAt: now,
    stageDurationsMs: {},
    browserWindowAvailable: false,
    browserFallbackAvailable: false,
    qrModeConfirmed: false,
    quickLoginGuardInstalled: false,
    scanDetected: false,
    lastFailure: null,
  };
}

function publicStageDurations(stageDurationsMs) {
  return Object.fromEntries(Object.entries(stageDurationsMs)
    .filter(([stage, duration]) => SAFE_ENROLLMENT_STAGES.has(stage) && Number.isFinite(duration))
    .map(([stage, duration]) => [stage, Math.min(Math.max(Math.trunc(duration), 0), DEFAULT_ENROLLMENT_TIMEOUT_MS)]));
}

function safeEnrollmentStage(value) {
  return SAFE_ENROLLMENT_STAGES.has(value) ? value : 'unknown';
}

function boundedPositiveNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(number), 250), DEFAULT_ENROLLMENT_TIMEOUT_MS);
}

function withTimeout(promise, timeoutMs, timeoutError) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeEnrollmentFailure(error, state) {
  const rawMessage = String(error?.message || error || '账号接入失败');
  const suppliedCode = String(error?.code || '');
  const suppliedStage = safeEnrollmentStage(error?.stage);
  if (suppliedCode) {
    return {
      code: suppliedCode,
      stage: suppliedStage === 'unknown' ? safeEnrollmentStage(state) : suppliedStage,
      message: publicEnrollmentError(rawMessage),
      retryable: true,
      fallbackAvailable: false,
    };
  }
  if (/page\.goto|navigation|net::|econnreset|enotfound|fetch failed|network error/i.test(rawMessage)) {
    return {
      code: /timeout/i.test(rawMessage) ? 'ima_navigation_timeout' : 'ima_navigation_network_error',
      stage: 'loading_ima',
      message: /timeout/i.test(rawMessage)
        ? 'IMA 页面加载超时（受控浏览器未在限定时间内建立页面连接）。请检查网络或代理后重试。'
        : 'IMA 页面连接失败。请检查网络、代理或 IMA 服务状态后重试。',
      retryable: true,
      fallbackAvailable: false,
    };
  }
  if (state === 'verifying') {
    return {
      code: 'knowledge_base_verification_failed',
      stage: 'verifying',
      message: '已检测到登录态，但共享知识库访问验证失败。请确认该账号已加入当前共享知识库后重新接入。',
      retryable: true,
      fallbackAvailable: false,
    };
  }
  if (/二维码登录已超时|生成登录二维码超时/i.test(rawMessage)) {
    return {
      code: 'enrollment_expired',
      stage: safeEnrollmentStage(state),
      message: '本次登录二维码已过期，请重新发起接入。',
      retryable: true,
      fallbackAvailable: false,
    };
  }
  return {
    code: 'enrollment_failed',
    stage: safeEnrollmentStage(state),
    message: publicEnrollmentError(rawMessage),
    retryable: true,
    fallbackAvailable: false,
  };
}

function publicEnrollmentError(message) {
  const rawMessage = String(message || '账号接入失败');
  if (/locator\.click|wait(?:ing)? for getbytext|page\.goto/i.test(rawMessage)) {
    return 'IMA 登录页响应超时，请检查网络后重新发起接入';
  }
  if (/fetch failed|network error|econnreset/i.test(rawMessage)) {
    return '登录二维码暂时无法加载，请检查网络后重新发起接入';
  }
  return rawMessage
    .replace(/IMA-[A-Z-]+=[^;\s]+/g, 'IMA-SECRET=[redacted]')
    .replace(/"x-ima-cookie"\s*:\s*"[^"]+"/gi, '"x-ima-cookie":"[redacted]"')
    .replace(/"cookie"\s*:\s*"[^"]+"/gi, '"cookie":"[redacted]"')
    .replace(/\/Users\/[^\s]+/g, '[path-redacted]')
    .slice(0, 240);
}

function removeProfileDirectory(directory) {
  if (!directory) {
    return;
  }
  try {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch {
    // The directory lives in the system temporary location and is not reported as an account error.
  }
}

function terminateBrowserProfile(directory) {
  void findBrowserProcessIds(directory).then((pids) => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Best-effort cleanup for this service-owned temporary profile only.
      }
    }
    const forceTimer = setTimeout(() => {
      void findBrowserProcessIds(directory).then((remainingPids) => {
        for (const pid of remainingPids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The browser may already have exited between process discovery and signal delivery.
          }
        }
        removeProfileDirectory(directory);
      });
    }, 750);
    forceTimer.unref?.();
  });
}

function findBrowserProcessIds(directory) {
  if (!directory) {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    const marker = `--user-data-dir=${directory}`;
    execFile('/bin/ps', ['-ax', '-o', 'pid=,command='], {
      timeout: 1500,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(String(stdout)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes(marker))
        .map((line) => Number(line.split(/\s+/, 1)[0]))
        .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid));
    });
  });
}

async function clickImaLoginControl(page) {
  try {
    const clicked = await page.evaluate(() => {
      const candidate = [...document.querySelectorAll('button, [role="button"], div')]
        .find((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return element.textContent?.trim() === '登录' && style.display !== 'none' &&
            style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        });
      candidate?.click();
      return Boolean(candidate);
    });
    if (clicked) {
      return true;
    }
  } catch {
    // IMA can replace its initial shell while scripts are loading.
  }
  if (typeof page.getByText !== 'function') {
    return false;
  }
  try {
    await page.getByText('登录', { exact: true }).first().click({ timeout: 2500, force: true });
    return true;
  } catch {
    return false;
  }
}

function cleanAccountName(value) {
  const name = String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80);
  if (!name) {
    throw enrollmentError('请输入账号名称', 400);
  }
  return name;
}

function cookieExpiryMs(cookies, name) {
  const cookie = cookies.find((item) => item.name === name);
  return cookie?.expires && cookie.expires > 0 ? Math.trunc(cookie.expires * 1000) : null;
}

function positiveNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

module.exports = {
  DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS,
  DEFAULT_ENROLLMENT_TIMEOUT_MS,
  WebAgentEnrollmentManager,
  captureLoginScreenshot,
  captureAuthFromContext,
  classifyImaLoginMode,
  classifyImaScanState,
  isQrLoginActionText,
  publicEnrollmentError,
  readDevToolsDebuggerUrl,
};
