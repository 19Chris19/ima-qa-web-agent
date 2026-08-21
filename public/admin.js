(function () {
  const login = document.querySelector('#adminLogin');
  const panel = document.querySelector('#adminPanel');
  const tokenForm = document.querySelector('#adminTokenForm');
  const tokenInput = document.querySelector('#adminTokenInput');
  const loginFeedback = document.querySelector('#loginFeedback');
  const reloadButton = document.querySelector('#reloadButton');
  const summary = document.querySelector('#adminSummary');
  const accountList = document.querySelector('#accountList');
  const accountCountLabel = document.querySelector('#accountCountLabel');
  const enrollFeedback = document.querySelector('#enrollFeedback');
  const startEnrollmentButton = document.querySelector('#startEnrollmentButton');
  const enrollmentDialog = document.querySelector('#enrollmentDialog');
  const closeEnrollmentButton = document.querySelector('#closeEnrollmentButton');
  const enrollmentForm = document.querySelector('#enrollmentForm');
  const enrollmentName = document.querySelector('#enrollmentName');
  const replaceEnrollment = document.querySelector('#replaceEnrollment');
  const createEnrollmentButton = document.querySelector('#createEnrollmentButton');
  const enrollmentProgress = document.querySelector('#enrollmentProgress');
  const enrollmentState = document.querySelector('#enrollmentState');
  const enrollmentStatusText = document.querySelector('#enrollmentStatusText');
  const enrollmentQr = document.querySelector('#enrollmentQr');
  const enrollmentQrNote = document.querySelector('#enrollmentQrNote');
  const enrollmentDiagnostic = document.querySelector('#enrollmentDiagnostic');
  const enrollmentDiagnosticTitle = document.querySelector('#enrollmentDiagnosticTitle');
  const enrollmentDiagnosticText = document.querySelector('#enrollmentDiagnosticText');
  const enrollmentResult = document.querySelector('#enrollmentResult');
  const focusEnrollmentWindowButton = document.querySelector('#focusEnrollmentWindowButton');
  const cancelEnrollmentButton = document.querySelector('#cancelEnrollmentButton');
  const enrollmentDialogFeedback = document.querySelector('#enrollmentDialogFeedback');
  const exercisePanel = document.querySelector('#exercisePanel');
  const exerciseCapacityLabel = document.querySelector('#exerciseCapacityLabel');
  const exerciseProfile = document.querySelector('#exerciseProfile');
  const exerciseClientCount = document.querySelector('#exerciseClientCount');
  const loadExerciseTemplatesButton = document.querySelector('#loadExerciseTemplatesButton');
  const expandExerciseScriptButton = document.querySelector('#expandExerciseScriptButton');
  const collapseExerciseScriptButton = document.querySelector('#collapseExerciseScriptButton');
  const exerciseScript = document.querySelector('#exerciseScript');
  const startExerciseButton = document.querySelector('#startExerciseButton');
  const cancelExerciseButton = document.querySelector('#cancelExerciseButton');
  const exerciseConfirmDialog = document.querySelector('#exerciseConfirmDialog');
  const exerciseConfirmText = document.querySelector('#exerciseConfirmText');
  const confirmExerciseButton = document.querySelector('#confirmExerciseButton');
  const cancelExerciseConfirmButton = document.querySelector('#cancelExerciseConfirmButton');
  const exerciseLive = document.querySelector('#exerciseLive');
  const exerciseLiveState = document.querySelector('#exerciseLiveState');
  const exerciseLiveElapsed = document.querySelector('#exerciseLiveElapsed');
  const exerciseLiveDetail = document.querySelector('#exerciseLiveDetail');
  const exerciseLiveMetrics = document.querySelector('#exerciseLiveMetrics');
  const exerciseFeedback = document.querySelector('#exerciseFeedback');
  const exerciseReportsPanel = document.querySelector('#exerciseReportsPanel');
  const exerciseReportList = document.querySelector('#exerciseReportList');
  const exerciseReportDetail = document.querySelector('#exerciseReportDetail');

  const tokenStorageKey = 'ima-qa-admin-token';
  let token = sessionStorage.getItem(tokenStorageKey) || '';
  let bootstrap = null;
  let accounts = [];
  let enrollment = null;
  let enrollmentPollTimer = null;
  let enrollmentQrUrl = '';
  let completedEnrollmentTaskId = '';
  let exercise = null;
  let activeExercise = null;
  let exerciseReports = [];
  let exercisePollTimer = null;

  tokenInput.value = token;
  tokenForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    token = tokenInput.value.trim();
    await loadAdminState();
  });
  reloadButton.addEventListener('click', () => loadAdminState());
  startEnrollmentButton.addEventListener('click', openEnrollmentDialog);
  closeEnrollmentButton.addEventListener('click', () => void closeEnrollmentDialog());
  enrollmentForm.addEventListener('submit', startEnrollment);
  focusEnrollmentWindowButton.addEventListener('click', focusEnrollmentWindow);
  cancelEnrollmentButton.addEventListener('click', cancelEnrollment);
  exerciseProfile.addEventListener('change', () => void loadExerciseTemplates());
  loadExerciseTemplatesButton.addEventListener('click', () => void loadExerciseTemplates());
  expandExerciseScriptButton.addEventListener('click', () => setDisclosureState(exerciseScript, true));
  collapseExerciseScriptButton.addEventListener('click', () => setDisclosureState(exerciseScript, false));
  startExerciseButton.addEventListener('click', () => void startExercise());
  cancelExerciseButton.addEventListener('click', () => void cancelExercise());
  confirmExerciseButton.addEventListener('click', () => void confirmExerciseStart());
  cancelExerciseConfirmButton.addEventListener('click', () => dismissExerciseConfirmation());
  enrollmentDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (isActiveEnrollment()) {
      void cancelEnrollment();
      return;
    }
    void closeEnrollmentDialog();
  });

  void loadAdminState();

  async function loadAdminState() {
    setFeedback(loginFeedback, '');
    reloadButton.disabled = true;
    try {
      const [bootstrapPayload, accountPayload] = await Promise.all([
        request('/api/admin/bootstrap'),
        request('/api/admin/accounts?details=1'),
      ]);
      bootstrap = bootstrapPayload;
      accounts = Array.isArray(accountPayload.accounts) ? accountPayload.accounts : [];
      sessionStorage.setItem(tokenStorageKey, token);
      login.hidden = true;
      panel.hidden = false;
      renderSummary(accountPayload.pool, accountPayload.queue);
      startEnrollmentButton.disabled = !bootstrap?.enrollment?.supportsAdminPageQr;
      startEnrollmentButton.title = bootstrap?.enrollment?.supportsAdminPageQr
        ? ''
        : '当前服务未启用页面二维码接入';
      renderAccounts();
      exercise = bootstrap?.exercise || null;
      renderExerciseShell();
      if (exercise) {
        await refreshExerciseReports();
        activeExercise = exercise.active || null;
        renderActiveExercise();
        if (activeExercise) {
          pollExercise();
        } else if (!exerciseScript.childElementCount) {
          await loadExerciseTemplates();
        }
      }
    } catch (error) {
      sessionStorage.removeItem(tokenStorageKey);
      token = '';
      tokenInput.value = '';
      login.hidden = false;
      panel.hidden = true;
      stopExercisePolling();
      setFeedback(loginFeedback, error.message || '无法读取账号状态', true);
    } finally {
      reloadButton.disabled = false;
    }
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-IMA-Admin-Token': token } : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      throw new Error(payload.error || `请求失败 (${response.status})`);
    }
    return payload;
  }

  function renderSummary(pool, queue) {
    const total = Number(pool?.totalAccounts || accounts.length || 0);
    const available = Number(pool?.availableAccounts || 0);
    const busy = Number(pool?.busyAccounts || 0);
    const cooling = Number(pool?.coolingDownAccounts || 0);
    summary.replaceChildren(
      createMetric('账号总数', total),
      createMetric('可用', available),
      createMetric('忙碌', busy),
      createMetric('冷却', cooling),
      createMetric('问答并发', Number(queue?.maxConcurrent || 1)),
    );
  }

  function createMetric(label, value) {
    const item = document.createElement('div');
    item.className = 'admin-metric';
    const number = document.createElement('strong');
    number.textContent = String(value);
    const text = document.createElement('span');
    text.textContent = label;
    item.append(number, text);
    return item;
  }

  function openEnrollmentDialog() {
    if (!bootstrap?.enrollment?.supportsAdminPageQr) {
      setFeedback(enrollFeedback, '当前服务未启用页面二维码接入', true);
      return;
    }
    const activeEnrollment = bootstrap?.enrollment?.activeEnrollment;
    if (activeEnrollment && isActiveEnrollmentState(activeEnrollment.state)) {
      enrollment = activeEnrollment;
      enrollmentForm.hidden = true;
      enrollmentProgress.hidden = false;
      renderEnrollment();
    } else {
      resetEnrollmentDialog();
    }
    enrollmentDialog.showModal();
    if (enrollment) {
      void refreshEnrollment();
    } else {
      enrollmentName.focus();
    }
  }

  async function closeEnrollmentDialog() {
    if (isActiveEnrollment()) {
      await cancelEnrollment({ closeDialog: true });
      return;
    }
    dismissEnrollmentDialog();
  }

  async function startEnrollment(event) {
    event.preventDefault();
    setFeedback(enrollmentDialogFeedback, '');
    createEnrollmentButton.disabled = true;
    try {
      const payload = await request('/api/admin/enrollments', {
        method: 'POST',
        body: JSON.stringify({
          name: cleanAccountName(enrollmentName.value),
          replace: replaceEnrollment.checked,
        }),
      });
      enrollment = payload.enrollment;
      completedEnrollmentTaskId = '';
      enrollmentForm.hidden = true;
      enrollmentProgress.hidden = false;
      renderEnrollment();
      await refreshEnrollment();
    } catch (error) {
      setFeedback(enrollmentDialogFeedback, error.message || '无法创建接入任务', true);
    } finally {
      createEnrollmentButton.disabled = false;
    }
  }

  async function refreshEnrollment() {
    if (!enrollment?.taskId) {
      return;
    }
    try {
      const payload = await request(`/api/admin/enrollments/${encodeURIComponent(enrollment.taskId)}`);
      enrollment = payload.enrollment;
      renderEnrollment();
      if (enrollment.qrAvailable) {
        await refreshEnrollmentQr();
      }
      if (isActiveEnrollment()) {
        enrollmentPollTimer = window.setTimeout(() => void refreshEnrollment(), 1200);
      } else if (enrollment.state === 'completed') {
        await finishCompletedEnrollment(enrollment);
      }
    } catch (error) {
      setFeedback(enrollmentDialogFeedback, error.message || '无法读取接入状态', true);
      stopEnrollmentPolling();
    }
  }

  async function finishCompletedEnrollment(completedEnrollment) {
    const taskId = String(completedEnrollment?.taskId || '');
    if (!taskId || completedEnrollmentTaskId === taskId) {
      return;
    }
    completedEnrollmentTaskId = taskId;
    stopEnrollmentPolling();
    const accountName = String(completedEnrollment?.account?.name || '新账号');
    dismissEnrollmentDialog();
    setFeedback(enrollFeedback, `账号 ${accountName} 已验证并加入账号池。`);
    await loadAdminState();
  }

  async function refreshEnrollmentQr() {
    const response = await fetch(`/api/admin/enrollments/${encodeURIComponent(enrollment.taskId)}/qr`, {
      headers: token ? { 'X-IMA-Admin-Token': token } : {},
      cache: 'no-store',
    });
    if (!response.ok) {
      return;
    }
    const image = await response.blob();
    revokeEnrollmentQr();
    enrollmentQrUrl = URL.createObjectURL(image);
    enrollmentQr.src = enrollmentQrUrl;
    enrollmentQr.hidden = false;
  }

  function renderEnrollment() {
    if (!enrollment) {
      return;
    }
    const active = isActiveEnrollment();
    const browserWindowAvailable = Boolean(enrollment.diagnostics?.browserWindowAvailable);
    const useVisibleBrowser = active && browserWindowAvailable;
    enrollmentState.textContent = enrollmentStateLabel(enrollment.state);
    enrollmentStatusText.textContent = enrollmentStatus(enrollment);
    cancelEnrollmentButton.hidden = !active;
    enrollmentQr.hidden = !enrollment.qrAvailable || useVisibleBrowser;
    enrollmentQrNote.hidden = !enrollment.qrAvailable || useVisibleBrowser;
    enrollmentResult.hidden = !enrollment.account;
    renderEnrollmentDiagnostic(enrollment.diagnostics);
    focusEnrollmentWindowButton.hidden = !active || (!browserWindowAvailable && !enrollment.diagnostics?.browserFallbackAvailable);
    focusEnrollmentWindowButton.textContent = browserWindowAvailable ? '定位受控登录窗口' : '打开受控登录窗口';
    enrollmentResult.textContent = enrollment.account
      ? `账号 ${enrollment.account.name} 已接入，当前状态：${statusLabel(enrollment.account.status)}。`
      : '';
    if (enrollment.error && enrollment.state !== 'cancelled') {
      setFeedback(enrollmentDialogFeedback, enrollment.error, true);
    }
    if (!active && enrollment.state === 'completed') {
      setFeedback(enrollmentDialogFeedback, '接入完成，账号池已刷新。');
    }
  }

  function renderEnrollmentDiagnostic(diagnostics) {
    const failure = diagnostics?.lastFailure;
    enrollmentDiagnostic.hidden = !failure;
    if (!failure) {
      enrollmentDiagnosticTitle.textContent = '';
      enrollmentDiagnosticText.textContent = '';
      return;
    }
    const failureStageMs = Number(diagnostics?.stageDurationsMs?.[failure.stage] || 0);
    const retryText = failure.retryable ? '可重试。' : '请处理提示后再试。';
    const fallbackText = failure.fallbackAvailable
      ? diagnostics?.browserWindowAvailable
        ? '受控登录窗口仍保留，可直接在窗口内继续扫码。'
        : '可点击“打开受控登录窗口”后继续扫码。'
      : '';
    const detail = enrollmentFailureDetail(failure.code, diagnostics);
    enrollmentDiagnosticTitle.textContent = `${enrollmentFailureLabel(failure.code)}（${enrollmentStateLabel(failure.stage)}）`;
    enrollmentDiagnosticText.textContent = [
      `错误编号：${String(failure.code || 'enrollment_failed').toUpperCase()}。`,
      failure.message,
      `影响范围：${detail.scope}。`,
      `处理建议：${detail.action}。`,
      failureStageMs > 0 ? `该阶段已等待 ${formatDuration(failureStageMs)}。` : '',
      retryText,
      fallbackText,
    ].filter(Boolean).join(' ');
  }

  async function focusEnrollmentWindow() {
    if (!enrollment?.taskId) {
      return;
    }
    focusEnrollmentWindowButton.disabled = true;
    try {
      const payload = await request(`/api/admin/enrollments/${encodeURIComponent(enrollment.taskId)}/focus-window`, {
        method: 'POST',
      });
      enrollment = payload.enrollment;
      renderEnrollment();
    } catch (error) {
      setFeedback(enrollmentDialogFeedback, error.message || '无法打开受控登录窗口', true);
    } finally {
      focusEnrollmentWindowButton.disabled = false;
    }
  }

  async function cancelEnrollment(options = {}) {
    if (!enrollment?.taskId || !isActiveEnrollment()) {
      dismissEnrollmentDialog();
      return;
    }
    const taskId = enrollment.taskId;
    const closeDialog = Boolean(options.closeDialog);
    cancelEnrollmentButton.disabled = true;
    if (closeDialog) {
      dismissEnrollmentDialog();
      setFeedback(enrollFeedback, '正在取消未完成的账号接入任务。');
    }
    try {
      const payload = await request(`/api/admin/enrollments/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
      });
      enrollment = payload.enrollment;
      if (closeDialog) {
        setFeedback(enrollFeedback, '未完成的账号接入已取消。');
        await loadAdminState();
      } else {
        renderEnrollment();
        stopEnrollmentPolling();
        revokeEnrollmentQr();
        dismissEnrollmentDialog();
      }
    } catch (error) {
      setFeedback(closeDialog ? enrollFeedback : enrollmentDialogFeedback, error.message || '无法取消接入', true);
      if (closeDialog) {
        await loadAdminState();
      }
    } finally {
      cancelEnrollmentButton.disabled = false;
    }
  }

  function dismissEnrollmentDialog() {
    stopEnrollmentPolling();
    revokeEnrollmentQr();
    if (enrollmentDialog.open) {
      enrollmentDialog.close();
    }
  }

  function resetEnrollmentDialog() {
    stopEnrollmentPolling();
    revokeEnrollmentQr();
    enrollment = null;
    completedEnrollmentTaskId = '';
    enrollmentForm.reset();
    enrollmentForm.hidden = false;
    enrollmentProgress.hidden = true;
    enrollmentQr.removeAttribute('src');
    enrollmentQr.hidden = true;
    enrollmentQrNote.hidden = true;
    enrollmentDiagnostic.hidden = true;
    enrollmentDiagnosticTitle.textContent = '';
    enrollmentDiagnosticText.textContent = '';
    enrollmentResult.hidden = true;
    enrollmentResult.textContent = '';
    setFeedback(enrollmentDialogFeedback, '');
  }

  function stopEnrollmentPolling() {
    if (enrollmentPollTimer) {
      window.clearTimeout(enrollmentPollTimer);
      enrollmentPollTimer = null;
    }
  }

  function revokeEnrollmentQr() {
    if (enrollmentQrUrl) {
      URL.revokeObjectURL(enrollmentQrUrl);
      enrollmentQrUrl = '';
    }
  }

  function isActiveEnrollment() {
    return isActiveEnrollmentState(enrollment?.state);
  }

  function isActiveEnrollmentState(state) {
    return ['launching_browser', 'loading_ima', 'opening_login', 'waiting_for_qr', 'waiting_for_scan', 'browser_fallback', 'verifying'].includes(state);
  }

  function enrollmentStateLabel(state) {
    return {
      launching_browser: '正在启动临时浏览器',
      loading_ima: '正在加载 IMA 登录页',
      opening_login: '正在打开扫码登录',
      waiting_for_qr: '正在读取登录二维码',
      waiting_for_scan: '等待扫码登录',
      browser_fallback: '可在受控窗口继续登录',
      verifying: '正在验证共享知识库',
      completed: '账号接入完成',
      failed: '账号接入失败',
      cancelled: '已取消接入',
    }[state] || '正在处理';
  }

  function enrollmentStatus(current) {
    if (current.state === 'waiting_for_scan') {
      const expiry = new Date(current.expiresAt);
      const prefix = current.diagnostics?.scanDetected
        ? '已收到微信扫码确认，正在等待 IMA 网页登录态同步；完成前不会新增账号。'
        : current.diagnostics?.browserWindowAvailable
          ? '受控 IMA 登录窗口已打开，请在该窗口内扫码并完成手机确认。'
        : current.detail || '二维码已就绪，请使用微信扫描下方二维码。';
      return Number.isNaN(expiry.getTime())
        ? prefix
        : `${prefix} 二维码将在 ${expiry.toLocaleTimeString('zh-CN', { hour12: false })} 前失效。`;
    }
    if (current.state === 'browser_fallback') {
      return current.detail || (current.diagnostics?.browserWindowAvailable
        ? '页面内二维码暂不可用。受控登录窗口仍在运行，请在窗口中完成扫码，服务会自动保存并验证登录态。'
        : '页面内二维码暂不可用。可打开受控登录窗口继续扫码，服务会自动保存并验证登录态。');
    }
    if (current.detail) {
      const activeStates = ['launching_browser', 'loading_ima', 'opening_login', 'waiting_for_qr', 'verifying'];
      const elapsedMs = Number(current.diagnostics?.elapsedMs || 0);
      return activeStates.includes(current.state) && elapsedMs >= 1000
        ? `${current.detail}（已等待 ${formatDuration(elapsedMs)}）`
        : current.detail;
    }
    if (current.state === 'verifying') {
      return '已检测到登录态，正在验证该账号是否可访问当前共享知识库。';
    }
    if (current.state === 'completed') {
      return '登录态已加密保存，临时二维码和浏览器资料已清理。';
    }
    return current.error || '正在准备安全的临时登录环境。';
  }

  function enrollmentFailureLabel(code) {
    return {
      browser_launch_timeout: '受控浏览器未完成启动',
      browser_connection_timeout: '浏览器后台接管延迟',
      browser_process_exit: '受控浏览器意外退出',
      ima_navigation_timeout: 'IMA 页面连接超时',
      ima_navigation_network_error: 'IMA 页面网络异常',
      login_control_timeout: '登录入口未就绪',
      qr_frame_timeout: '二维码框架未就绪',
      qr_capture_retrying: '二维码读取暂缓',
      browser_window_focus_failed: '受控窗口无法置前',
      knowledge_base_verification_failed: '共享知识库验证失败',
      enrollment_expired: '登录任务已过期',
      quick_login_blocked: '已阻止快捷登录',
      enrollment_failed: '账号接入失败',
    }[code] || '账号接入诊断';
  }

  function enrollmentFailureDetail(code, diagnostics = {}) {
    return {
      browser_launch_timeout: {
        scope: '本机维护环境，尚未开始访问 IMA',
        action: '确认 Chrome/Chromium 可在运行服务的图形桌面启动后重试',
      },
      browser_connection_timeout: {
        scope: diagnostics.browserWindowAvailable ? '受控窗口已打开，IMA 登录可继续进行' : '后台登录浏览器已启动，页面二维码尚未可读',
        action: diagnostics.browserWindowAvailable
          ? '直接在受控窗口扫码；服务会继续等待并自动保存登录态'
          : '在管理页继续等待二维码，或点击“打开受控登录窗口”后扫码',
      },
      browser_process_exit: {
        scope: '受控浏览器窗口已关闭，尚未完成登录',
        action: '重新发起接入，并保持临时浏览器窗口打开',
      },
      ima_navigation_timeout: {
        scope: 'IMA 页面访问，浏览器本身已正常启动',
        action: diagnostics.browserWindowAvailable
          ? '检查维护机网络、代理或 IMA 服务后重试；也可在保留窗口内继续等待页面加载'
          : '检查维护机网络、代理或 IMA 服务后重试；也可打开受控登录窗口继续等待页面加载',
      },
      ima_navigation_network_error: {
        scope: 'IMA 页面访问，浏览器本身已正常启动',
        action: '检查维护机网络、代理或 IMA 服务后重试',
      },
      login_control_timeout: {
        scope: 'IMA 登录页界面，尚未影响账号池',
        action: diagnostics.browserWindowAvailable
          ? '在受控窗口内等待或手动点开登录，再完成扫码'
          : '打开受控登录窗口后等待或手动点开登录，再完成扫码',
      },
      qr_frame_timeout: {
        scope: '二维码读取，不代表 IMA 登录窗口不可用',
        action: diagnostics.browserWindowAvailable
          ? '在受控窗口内扫码，服务会继续检测登录态'
          : '点击“打开受控登录窗口”后扫码，服务会继续检测登录态',
      },
      knowledge_base_verification_failed: {
        scope: '登录成功后的共享知识库权限验证',
        action: '确认账号已加入当前共享知识库后重新接入',
      },
      enrollment_expired: {
        scope: '本次临时登录任务',
        action: '重新生成一次性二维码',
      },
      quick_login_blocked: {
        scope: '本次临时登录任务，未写入账号池',
        action: '重新生成二维码，并只使用待接入账号的微信扫描；不要在受控浏览器中选择快捷登录',
      },
    }[code] || {
      scope: '当前接入任务',
      action: '按提示处理后重新发起接入',
    };
  }

  function formatDuration(value) {
    const seconds = Math.max(0, Math.round(Number(value || 0) / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  }

  function renderExerciseShell() {
    const enabled = Boolean(exercise);
    exercisePanel.hidden = !enabled;
    exerciseReportsPanel.hidden = !enabled;
    if (!enabled) {
      return;
    }
    const available = Number(exercise.availableAccountCount || 0);
    const retention = Number(exercise.reportRetentionDays || 7);
    const questionBankCount = Number(exercise.questionBankCount || 0);
    const baseline = Number(exercise.profiles?.baseline || available || 0);
    const queue = Number(exercise.profiles?.queue || 0);
    exerciseCapacityLabel.textContent = available
      ? `当前 ${available} 个独立可用账号：基线 ${baseline} 路，排队压力 ${queue} 路；题库 ${questionBankCount || '未读取'} 道，单次最多 ${exercise.maxClients || 30} 位，自动分配不重复；报告保留 ${retention} 天`
      : '当前没有可用独立账号。接入并检查账号后才能启动真实演练。';
    const target = profileClientCount(exerciseProfile.value);
    exerciseClientCount.max = String(Number(exercise.maxClients || 30));
    exerciseClientCount.value = String(target);
    exerciseClientCount.disabled = exerciseProfile.value !== 'custom' || Boolean(activeExercise);
    exerciseProfile.disabled = Boolean(activeExercise);
    loadExerciseTemplatesButton.disabled = Boolean(activeExercise) || !available;
    startExerciseButton.disabled = Boolean(activeExercise) || !available;
    const hasScript = Boolean(exerciseScript.childElementCount);
    expandExerciseScriptButton.disabled = Boolean(activeExercise) || !hasScript;
    collapseExerciseScriptButton.disabled = Boolean(activeExercise) || !hasScript;
    cancelExerciseButton.hidden = !activeExercise;
  }

  function profileClientCount(profile) {
    const available = Number(exercise?.availableAccountCount || 0);
    if (profile === 'queue') {
      return Number(exercise?.profiles?.queue || Math.min(30, available * 2) || 1);
    }
    if (profile === 'custom') {
      const value = Number(exerciseClientCount.value || available || 1);
      return Math.max(1, Math.min(Number(exercise?.maxClients || 30), Math.trunc(value) || 1));
    }
    return Number(exercise?.profiles?.baseline || available || 1);
  }

  async function loadExerciseTemplates() {
    if (!exercise || activeExercise) {
      return;
    }
    const count = profileClientCount(exerciseProfile.value);
    exerciseClientCount.value = String(count);
    loadExerciseTemplatesButton.disabled = true;
    setFeedback(exerciseFeedback, '正在加载知识库相关的 3DGS 演练题目…');
    try {
      const payload = await request(`/api/admin/exercises/templates?count=${encodeURIComponent(count)}`);
      exercise = payload.exercise || exercise;
      renderExerciseScript(payload.clients || []);
      renderExerciseShell();
      const manualCount = (payload.clients || []).filter((client) => client.requiresManualQuestion).length;
      setFeedback(
        exerciseFeedback,
        manualCount
          ? `已分配 ${(payload.clients || []).length - manualCount} 道不重复题目；${manualCount} 位模拟用户需要手写首问。`
          : `已生成 ${(payload.clients || []).length} 道不重复的可编辑题目。`,
      );
    } catch (error) {
      setFeedback(exerciseFeedback, error.message || '无法生成演练题目', true);
    } finally {
      loadExerciseTemplatesButton.disabled = false;
    }
  }

  function renderExerciseScript(clients) {
    exerciseScript.replaceChildren();
    for (const [index, client] of clients.entries()) {
      const row = document.createElement('details');
      row.className = 'admin-exercise-script-row';
      row.dataset.exerciseClientIndex = String(index);
      row.open = index === 0;
      const summary = document.createElement('summary');
      summary.className = 'admin-exercise-script-summary';
      const summaryIdentity = document.createElement('span');
      summaryIdentity.className = 'admin-exercise-script-summary-identity';
      const summaryTitle = document.createElement('strong');
      const summaryCategory = document.createElement('span');
      summaryIdentity.append(summaryTitle, summaryCategory);
      const summaryQuestion = document.createElement('span');
      summaryQuestion.className = 'admin-exercise-script-summary-question';
      summary.append(summaryIdentity, summaryQuestion);
      const content = document.createElement('div');
      content.className = 'admin-exercise-script-content';
      const header = document.createElement('div');
      header.className = 'admin-exercise-script-heading';
      const title = document.createElement('strong');
      title.textContent = `模拟用户 ${index + 1}`;
      const category = document.createElement('span');
      category.textContent = categoryLabel(client.category);
      header.append(title, category);

      const label = document.createElement('input');
      label.className = 'admin-exercise-label';
      label.maxLength = 80;
      label.value = client.label || `模拟用户 ${index + 1}`;
      label.setAttribute('aria-label', `模拟用户 ${index + 1} 名称`);
      const clientLabel = document.createElement('label');
      clientLabel.className = 'admin-exercise-client-label';
      clientLabel.textContent = '客户显示名';
      clientLabel.append(label);
      const question = createExerciseTextarea(client.question, `模拟用户 ${index + 1} 首问`);
      const followUp = createExerciseTextarea(client.followUp, `模拟用户 ${index + 1} 追问`);
      followUp.dataset.turn = 'followUp';
      question.dataset.turn = 'initial';
      if (client.requiresManualQuestion) {
        question.placeholder = '题库没有剩余未重复题目，请手写与共享知识库相关的首问';
      }
      const initialTurn = createExerciseScriptTurn('首问', question, index === 0);
      const followUpTurn = createExerciseScriptTurn('追问', followUp, false);
      const updateSummary = () => {
        const clientName = label.value.trim() || `模拟用户 ${index + 1}`;
        summaryTitle.textContent = clientName;
        summaryCategory.textContent = client.requiresManualQuestion ? '需手写首问' : categoryLabel(client.category);
        summaryQuestion.textContent = question.value.trim()
          ? shortenText(question.value, 72)
          : '首问待填写';
        initialTurn.preview.textContent = question.value.trim() ? shortenText(question.value, 54) : '首问待填写';
        followUpTurn.preview.textContent = followUp.value.trim() ? shortenText(followUp.value, 54) : '未设置追问';
      };
      label.addEventListener('input', updateSummary);
      question.addEventListener('input', updateSummary);
      followUp.addEventListener('input', updateSummary);
      updateSummary();
      content.append(header, clientLabel, initialTurn.details, followUpTurn.details);
      row.append(summary, content);
      exerciseScript.appendChild(row);
    }
  }

  function createExerciseScriptTurn(label, textarea, open) {
    const details = document.createElement('details');
    details.className = 'admin-exercise-script-turn';
    details.open = open;
    const summary = document.createElement('summary');
    summary.className = 'admin-exercise-script-turn-summary';
    const title = document.createElement('strong');
    title.textContent = label;
    const preview = document.createElement('span');
    summary.append(title, preview);
    const content = document.createElement('div');
    content.className = 'admin-exercise-script-turn-content';
    content.appendChild(textarea);
    details.append(summary, content);
    return { details, preview };
  }

  function createExerciseTextarea(value, label) {
    const textarea = document.createElement('textarea');
    textarea.maxLength = 2000;
    textarea.rows = 3;
    textarea.value = value || '';
    textarea.setAttribute('aria-label', label);
    return textarea;
  }

  function collectExerciseClients() {
    return [...exerciseScript.querySelectorAll('[data-exercise-client-index]')].map((row, index) => ({
      label: row.querySelector('.admin-exercise-label')?.value.trim() || `模拟用户 ${index + 1}`,
      question: row.querySelector('[data-turn="initial"]')?.value.trim() || '',
      followUp: row.querySelector('[data-turn="followUp"]')?.value.trim() || '',
    }));
  }

  async function startExercise() {
    if (!exercise || activeExercise) {
      return;
    }
    const clients = collectExerciseClients();
    if (!clients.length || clients.some((client) => !client.question)) {
      setFeedback(exerciseFeedback, '每位模拟用户都需要填写首问。', true);
      return;
    }
    exerciseConfirmText.textContent = `将使用 ${clients.length} 位模拟用户，向真实 IMA 共享知识库发起首问与追问。请确认脚本无误后开始。`;
    if (exerciseConfirmDialog.open) {
      return;
    }
    exerciseConfirmDialog.showModal();
  }

  async function confirmExerciseStart() {
    if (!exercise || activeExercise) {
      dismissExerciseConfirmation();
      return;
    }
    const clients = collectExerciseClients();
    if (!clients.length || clients.some((client) => !client.question)) {
      dismissExerciseConfirmation();
      setFeedback(exerciseFeedback, '每位模拟用户都需要填写首问。', true);
      return;
    }
    const profile = exerciseProfile.value;
    confirmExerciseButton.disabled = true;
    cancelExerciseConfirmButton.disabled = true;
    dismissExerciseConfirmation();
    startExerciseButton.disabled = true;
    setFeedback(exerciseFeedback, '正在启动真实 IMA 账号池演练…');
    try {
      const payload = await request('/api/admin/exercises', {
        method: 'POST',
        body: JSON.stringify({ profile, confirm: true, clients }),
      });
      activeExercise = payload.run;
      renderExerciseShell();
      renderActiveExercise();
      pollExercise();
    } catch (error) {
      setFeedback(exerciseFeedback, error.message || '无法启动演练', true);
    } finally {
      confirmExerciseButton.disabled = false;
      cancelExerciseConfirmButton.disabled = false;
      if (!activeExercise) {
        startExerciseButton.disabled = false;
      }
    }
  }

  function dismissExerciseConfirmation() {
    if (exerciseConfirmDialog.open) {
      exerciseConfirmDialog.close();
    }
  }

  async function cancelExercise() {
    if (!activeExercise?.runId) {
      return;
    }
    cancelExerciseButton.disabled = true;
    try {
      const payload = await request(`/api/admin/exercises/${encodeURIComponent(activeExercise.runId)}/cancel`, { method: 'POST' });
      activeExercise = payload.run;
      renderActiveExercise();
      setFeedback(exerciseFeedback, '正在取消剩余请求，完成部分报告后会恢复普通问答。');
    } catch (error) {
      setFeedback(exerciseFeedback, error.message || '无法取消演练', true);
    } finally {
      cancelExerciseButton.disabled = false;
    }
  }

  async function pollExercise() {
    stopExercisePolling();
    try {
      const payload = await request('/api/admin/exercises/active');
      activeExercise = payload.run || null;
      renderExerciseShell();
      renderActiveExercise();
      if (activeExercise) {
        exercisePollTimer = window.setTimeout(() => void pollExercise(), 900);
        return;
      }
      await refreshExerciseReports();
      setFeedback(exerciseFeedback, '演练已结束，普通问答已恢复。请在下方按模拟用户逐题复核。');
    } catch (error) {
      setFeedback(exerciseFeedback, error.message || '无法读取演练状态', true);
    }
  }

  function stopExercisePolling() {
    if (exercisePollTimer) {
      window.clearTimeout(exercisePollTimer);
      exercisePollTimer = null;
    }
  }

  function renderActiveExercise() {
    exerciseLive.hidden = !activeExercise;
    if (!activeExercise) {
      return;
    }
    const phase = activeExercise.phase === 'follow_up' ? '正在发送追问' : '正在发送首问';
    const state = activeExercise.status === 'cancelling' ? '正在取消演练' : phase;
    exerciseLiveState.textContent = state;
    exerciseLiveElapsed.textContent = `已运行 ${formatDuration(Date.now() - Number(activeExercise.startedAt || Date.now()))}`;
    const progress = activeExercise.progress || {};
    const queue = activeExercise.queue || {};
    const pool = activeExercise.pool || {};
    exerciseLiveDetail.textContent = `模拟客户 ${activeExercise.requestedClients || 0} 位；普通问答已暂停，演练完成后自动恢复。`;
    exerciseLiveMetrics.replaceChildren(
      createMetric('已提交', Number(progress.submitted || 0)),
      createMetric('处理中', Number(progress.processing || 0)),
      createMetric('演练排队', Number(progress.queued || 0)),
      createMetric('完成', Number(progress.completed || 0)),
      createMetric('失败', Number(progress.failed || 0)),
      createMetric('服务排队', Number(queue.queuedRequests || 0)),
      createMetric('账号忙碌', Number(pool.busyAccounts || 0)),
      createMetric('可用账号', Number(pool.availableAccounts || 0)),
    );
  }

  async function refreshExerciseReports() {
    if (!exercise) {
      return;
    }
    try {
      const payload = await request('/api/admin/exercises/reports');
      exerciseReports = Array.isArray(payload.reports) ? payload.reports : [];
      renderExerciseReports();
    } catch (error) {
      setFeedback(exerciseFeedback, error.message || '无法读取演练报告', true);
    }
  }

  function renderExerciseReports() {
    exerciseReportList.replaceChildren();
    if (!exerciseReports.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = '暂无已完成的演练报告';
      exerciseReportList.appendChild(empty);
      return;
    }
    for (const report of exerciseReports) {
      const row = document.createElement('article');
      row.className = 'admin-exercise-report-row';
      const body = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${exerciseProfileLabel(report.profile)} · ${formatDate(report.startedAt)}`;
      const meta = document.createElement('p');
      meta.textContent = reportSummaryText(report);
      body.append(title, meta);
      const actions = document.createElement('div');
      actions.className = 'admin-account-actions';
      actions.append(
        createAction('复核', () => void openExerciseReport(report.id)),
        createAction('下载 JSON', () => void downloadExerciseReport(report.id)),
        createAction('删除', () => void deleteExerciseReport(report)),
      );
      row.append(body, actions);
      exerciseReportList.appendChild(row);
    }
  }

  async function openExerciseReport(reportId) {
    try {
      const payload = await request(`/api/admin/exercises/reports/${encodeURIComponent(reportId)}`);
      renderExerciseReportDetail(payload.report);
    } catch (error) {
      setFeedback(exerciseFeedback, error.message || '无法打开演练报告', true);
    }
  }

  function renderExerciseReportDetail(report) {
    const disclosureStates = captureDisclosureStates(exerciseReportDetail);
    exerciseReportDetail.replaceChildren();
    if (!report) {
      return;
    }
    const heading = document.createElement('div');
    heading.className = 'admin-exercise-report-detail-heading';
    const title = document.createElement('h3');
    title.textContent = `${exerciseProfileLabel(report.profile)}复核`;
    const meta = document.createElement('p');
    meta.textContent = detailedReportSummaryText(report);
    const actions = document.createElement('div');
    actions.className = 'admin-disclosure-actions';
    actions.append(
      createAction('全部展开', () => setDisclosureState(exerciseReportDetail, true)),
      createAction('全部收起', () => setDisclosureState(exerciseReportDetail, false)),
      createAction('收起复核', () => exerciseReportDetail.replaceChildren()),
    );
    heading.append(title, meta, actions);
    exerciseReportDetail.appendChild(heading);
    for (const client of report.clients || []) {
      exerciseReportDetail.appendChild(renderExerciseClientReview(report, client, disclosureStates));
    }
  }

  function renderExerciseClientReview(report, client, disclosureStates = new Map()) {
    const article = document.createElement('details');
    article.className = 'admin-exercise-client-review';
    const disclosureKey = `report-client-${client.index}`;
    article.dataset.disclosureKey = disclosureKey;
    article.open = disclosureStates.has(disclosureKey) ? disclosureStates.get(disclosureKey) : client.index === 0;
    const summary = document.createElement('summary');
    summary.className = 'admin-exercise-client-summary';
    const title = document.createElement('strong');
    title.textContent = client.label || `模拟用户 ${Number(client.index || 0) + 1}`;
    const checks = document.createElement('span');
    checks.className = 'admin-account-meta';
    checks.textContent = clientChecksText(client);
    summary.append(title, checks);
    const content = document.createElement('div');
    content.className = 'admin-exercise-client-review-content';
    content.append(renderExerciseTurn('首问', client.initial, `report-client-${client.index}-initial`, disclosureStates, true));
    if (client.followUp?.question) {
      content.append(renderExerciseTurn('追问', client.followUp, `report-client-${client.index}-follow-up`, disclosureStates, false));
    }
    const review = document.createElement('section');
    review.className = 'admin-exercise-review';
    const reviewTitle = document.createElement('strong');
    reviewTitle.textContent = '人工质量复核';
    const scores = document.createElement('div');
    scores.className = 'admin-exercise-score-grid';
    const keys = [
      ['relevance', '知识库相关性'],
      ['completeness', '回答完整性'],
      ['sourceTrust', '来源可信度'],
      ['followUpContinuity', '追问连贯性'],
    ];
    for (const [key, label] of keys) {
      scores.append(createScoreControl(key, label, client.review?.[key]));
    }
    const note = document.createElement('textarea');
    note.rows = 3;
    note.maxLength = 2000;
    note.placeholder = '复核备注（可选）';
    note.value = client.review?.note || '';
    note.dataset.reviewNote = 'true';
    const save = createAction('保存评分', () => void saveExerciseReview(report.id, client.index, review));
    review.append(reviewTitle, scores, note, save);
    content.appendChild(review);
    article.append(summary, content);
    return article;
  }

  function renderExerciseTurn(label, turn = {}, disclosureKey, disclosureStates = new Map(), defaultOpen = false) {
    const section = document.createElement('details');
    section.className = 'admin-exercise-turn';
    section.dataset.disclosureKey = disclosureKey;
    section.open = disclosureStates.has(disclosureKey) ? disclosureStates.get(disclosureKey) : defaultOpen;
    const heading = document.createElement('summary');
    heading.className = 'admin-exercise-turn-summary';
    const title = document.createElement('strong');
    title.textContent = label;
    const status = document.createElement('span');
    status.className = `admin-account-status ${turn.ok ? 'available' : 'disabled'}`;
    status.textContent = turn.ok ? '完成' : turn.status === 'cancelled' ? '已取消' : '失败';
    const questionPreview = document.createElement('span');
    questionPreview.textContent = shortenText(turn.question, 72);
    heading.append(title, status, questionPreview);
    const content = document.createElement('div');
    content.className = 'admin-exercise-turn-content';
    const question = document.createElement('p');
    question.className = 'admin-exercise-question';
    question.textContent = turn.question || '';
    const performance = document.createElement('p');
    performance.className = 'admin-account-meta';
    performance.textContent = turnPerformanceText(turn);
    content.append(question, performance);
    if (turn.answer) {
      const answer = document.createElement('div');
      answer.className = 'answer-markdown admin-exercise-answer';
      answer.innerHTML = window.ImaAnswerMarkdown?.formatAnswerHtml
        ? window.ImaAnswerMarkdown.formatAnswerHtml(turn.answer)
        : escapeHtml(turn.answer).replace(/\n/g, '<br>');
      content.appendChild(answer);
    }
    if (turn.sources?.length) {
      const sources = document.createElement('div');
      sources.className = 'admin-exercise-sources';
      const sourceTitle = document.createElement('strong');
      sourceTitle.textContent = turn.searchSummary || `找到 ${turn.sources.length} 篇知识库资料`;
      sources.appendChild(sourceTitle);
      for (const source of turn.sources) {
        const item = document.createElement('p');
        item.textContent = `[${source.index || 1}] ${source.title || '知识库资料'}${source.snippet ? `：${source.snippet}` : ''}`;
        sources.appendChild(item);
      }
      content.appendChild(sources);
    }
    if (turn.error) {
      const error = document.createElement('p');
      error.className = 'admin-feedback error';
      error.textContent = `${failureLabel(turn.failureReason)}：${turn.error}`;
      content.appendChild(error);
    }
    section.append(heading, content);
    return section;
  }

  function setDisclosureState(container, open) {
    for (const details of container.querySelectorAll('details')) {
      details.open = open;
    }
  }

  function captureDisclosureStates(container) {
    const states = new Map();
    for (const details of container.querySelectorAll('details[data-disclosure-key]')) {
      states.set(details.dataset.disclosureKey, details.open);
    }
    return states;
  }

  function shortenText(value, maxLength) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  function createScoreControl(key, label, value) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const select = document.createElement('select');
    select.dataset.scoreKey = key;
    for (const [score, text] of [['', '未评分'], ['0', '0 不合格'], ['1', '1 部分满足'], ['2', '2 合格']]) {
      const option = document.createElement('option');
      option.value = score;
      option.textContent = text;
      option.selected = String(value ?? '') === score;
      select.appendChild(option);
    }
    wrapper.appendChild(select);
    return wrapper;
  }

  async function saveExerciseReview(reportId, clientIndex, container) {
    const review = { note: container.querySelector('[data-review-note]')?.value || '' };
    for (const select of container.querySelectorAll('[data-score-key]')) {
      review[select.dataset.scoreKey] = select.value === '' ? null : Number(select.value);
    }
    try {
      const payload = await request(`/api/admin/exercises/reports/${encodeURIComponent(reportId)}/reviews/${encodeURIComponent(clientIndex)}`, {
        method: 'PUT',
        body: JSON.stringify(review),
      });
      renderExerciseReportDetail(payload.report);
      await refreshExerciseReports();
      setFeedback(exerciseFeedback, '人工复核已保存。');
    } catch (error) {
      setFeedback(exerciseFeedback, error.message || '无法保存评分', true);
    }
  }

  async function downloadExerciseReport(reportId) {
    try {
      const response = await fetch(`/api/admin/exercises/reports/${encodeURIComponent(reportId)}/export`, {
        headers: token ? { 'X-IMA-Admin-Token': token } : {},
        cache: 'no-store',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `下载失败 (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ima-account-pool-exercise-${reportId}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setFeedback(exerciseFeedback, error.message || '无法下载报告', true);
    }
  }

  async function deleteExerciseReport(report) {
    if (!window.confirm(`删除 ${formatDate(report.startedAt)} 的演练报告？此操作不可恢复。`)) {
      return;
    }
    try {
      await request(`/api/admin/exercises/reports/${encodeURIComponent(report.id)}`, { method: 'DELETE' });
      exerciseReportDetail.replaceChildren();
      await refreshExerciseReports();
      setFeedback(exerciseFeedback, '演练报告已删除。');
    } catch (error) {
      setFeedback(exerciseFeedback, error.message || '无法删除报告', true);
    }
  }

  function exerciseProfileLabel(profile) {
    return { baseline: '基线并发', queue: '排队压力', custom: '自定义演练' }[profile] || '账号池演练';
  }

  function categoryLabel(category) {
    return {
      basic_principles: '基础原理',
      capture_devices: '采集与设备',
      training_workflow: '训练流程',
      advanced_troubleshooting: '高阶排障',
      rendering_application: '渲染与应用',
    }[category] || '3DGS 题库';
  }

  function reportSummaryText(report) {
    const initial = report.initial || {};
    const followUp = report.followUp || {};
    const review = report.reviewSummary || {};
    return `首问 ${initial.ok || 0}/${initial.total || 0}，追问 ${followUp.ok || 0}/${followUp.total || 0}，已复核 ${review.reviewedClients || 0}/${(initial.total || 0)}，总分 ${review.totalScore || 0}/${review.maxScore || 0}`;
  }

  function detailedReportSummaryText(report) {
    const summary = report.summary || {};
    const coverage = summary.accountCoverage || {};
    const isolation = summary.isolation || {};
    return [
      `首问 ${summary.initial?.ok || 0}/${summary.initial?.total || 0}`,
      `追问 ${summary.followUp?.ok || 0}/${summary.followUp?.total || 0}`,
      `峰值并发 ${summary.peakActiveRequests || 0}`,
      `峰值排队 ${summary.peakQueuedRequests || 0}`,
      coverage.passed ? '账号覆盖通过' : '账号覆盖未完整',
      isolation.sessionIsolationPassed ? '会话隔离通过' : '会话隔离异常',
      isolation.followUpContinuityPassed ? '追问连续性通过' : '追问连续性异常',
      summary.scenario?.passed == null ? '自定义演练' : summary.scenario.passed ? '演练结论通过' : '演练结论未通过',
    ].join(' · ');
  }

  function clientChecksText(client) {
    const checks = client.checks || {};
    return [
      checks.initialSessionCreated ? '首问已建立独立会话' : '首问未建立会话',
      checks.followUpSameAccount == null ? '未配置追问' : checks.followUpSameAccount ? '追问回到原账号' : '追问账号切换异常',
      checks.followUpSameSession == null ? '未配置追问' : checks.followUpSameSession ? '追问回到同一会话' : '追问连续性异常',
    ].join(' · ');
  }

  function turnPerformanceText(turn) {
    const items = [];
    if (turn.accountName) items.push(`账号 ${turn.accountName}`);
    if (turn.queueMs != null) items.push(`排队 ${formatMilliseconds(turn.queueMs)}`);
    if (turn.firstResponseMs != null) items.push(`首段 ${formatMilliseconds(turn.firstResponseMs)}`);
    if (turn.totalMs != null) items.push(`完成 ${formatMilliseconds(turn.totalMs)}`);
    if (turn.failureReason) items.push(failureLabel(turn.failureReason));
    return items.join(' · ') || '暂无性能数据';
  }

  function failureLabel(reason) {
    return {
      auth_failure: '登录失效',
      rate_limited: '上游限流',
      timeout: '超时',
      network_failure: '网络失败',
      account_unavailable: '账号不可用',
      upstream_failure: '上游失败',
      cancelled: '已取消',
    }[reason] || reason || '请求失败';
  }

  function formatMilliseconds(value) {
    const milliseconds = Math.max(0, Number(value || 0));
    return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)} 秒` : `${Math.round(milliseconds)} 毫秒`;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderAccounts() {
    accountList.replaceChildren();
    accountCountLabel.textContent = `${accounts.length} 个账号`;
    if (!accounts.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = '暂无已接入账号';
      accountList.appendChild(empty);
      return;
    }

    for (const account of accounts) {
      const row = document.createElement('article');
      row.className = 'admin-account-row';
      const heading = document.createElement('div');
      heading.className = 'admin-account-heading';
      const name = document.createElement('h3');
      name.textContent = account.name;
      const status = document.createElement('span');
      status.className = `admin-account-status ${account.status || 'unknown'}`;
      status.textContent = statusLabel(account.status);
      heading.append(name, status);

      const meta = document.createElement('p');
      meta.className = 'admin-account-meta';
      meta.textContent = accountMeta(account);

      const actions = document.createElement('div');
      actions.className = 'admin-account-actions';
      const accountActions = [
        createAction('检查', () => runAccountAction(account.id, 'check')),
        createAction('刷新', () => runAccountAction(account.id, 'refresh')),
      ];
      if (!account.identityDuplicate) {
        accountActions.push(createAction(account.status === 'disabled' ? '启用' : '停用', () =>
          runAccountAction(account.id, account.status === 'disabled' ? 'enable' : 'disable'),
        ));
      }
      accountActions.push(createAction('删除', () => deleteAccount(account)));
      actions.append(...accountActions);
      row.append(heading, meta, actions);
      accountList.appendChild(row);
    }
  }

  function createAction(label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }

  async function runAccountAction(accountId, action) {
    try {
      await request(`/api/admin/accounts/${encodeURIComponent(accountId)}/${action}`, { method: 'POST', body: '{}' });
      await loadAdminState();
    } catch (error) {
      setFeedback(enrollFeedback, error.message || '账号操作失败', true);
    }
  }

  async function deleteAccount(account) {
    if (!window.confirm(`删除账号“${account.name}”？此操作不会删除 IMA 账号本身。`)) {
      return;
    }
    try {
      await request(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
      await loadAdminState();
    } catch (error) {
      setFeedback(enrollFeedback, error.message || '删除失败', true);
    }
  }

  function accountMeta(account) {
    const items = [];
    if (account.identityDuplicate) {
      items.push('与另一条记录是同一 IMA 登录身份，已自动停用，不计入并发');
    } else if (account.identityVerified) {
      items.push('IMA 登录身份已校验');
    }
    if (Number(account.activeRequests || 0)) {
      items.push(`处理中 ${account.activeRequests}`);
    }
    if (Number(account.cooldownSecondsRemaining || 0)) {
      items.push(`冷却 ${account.cooldownSecondsRemaining} 秒`);
    }
    if (account.tokenExpiresAt) {
      items.push(`访问令牌 ${formatDate(account.tokenExpiresAt)}`);
    }
    if (account.refreshTokenExpiresAt) {
      items.push(`刷新令牌 ${formatDate(account.refreshTokenExpiresAt)}`);
    }
    if (account.lastError) {
      items.push(account.lastError);
    }
    return items.join(' · ') || '尚未使用';
  }

  function statusLabel(status) {
    return {
      available: '可用',
      busy: '处理中',
      cooling_down: '冷却中',
      disabled: '已停用',
    }[status] || '未知';
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
  }

  function setFeedback(target, message, isError = false) {
    target.textContent = message;
    target.classList.toggle('error', Boolean(isError));
  }

  function cleanAccountName(value) {
    return String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80);
  }

})();
