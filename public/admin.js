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
  const addAccountButton = document.querySelector('#addAccountButton');
  const enrollmentDialog = document.querySelector('#enrollmentDialog');
  const enrollmentDialogTitle = document.querySelector('#enrollmentDialogTitle');
  const enrollmentDialogDescription = document.querySelector('#enrollmentDialogDescription');
  const closeEnrollmentButton = document.querySelector('#closeEnrollmentButton');
  const enrollmentForm = document.querySelector('#enrollmentForm');
  const enrollmentName = document.querySelector('#enrollmentName');
  const replaceEnrollment = document.querySelector('#replaceEnrollment');
  const createEnrollmentButton = document.querySelector('#createEnrollmentButton');
  const enrollmentProgress = document.querySelector('#enrollmentProgress');
  const enrollmentState = document.querySelector('#enrollmentState');
  const enrollmentStatusText = document.querySelector('#enrollmentStatusText');
  const enrollmentQualificationNotice = document.querySelector('#enrollmentQualificationNotice');
  const enrollmentQualificationStatus = document.querySelector('#enrollmentQualificationStatus');
  const enrollmentShareLink = document.querySelector('#enrollmentShareLink');
  const continueMembershipButton = document.querySelector('#continueMembershipButton');
  const retryEnrollmentQualificationButton = document.querySelector('#retryEnrollmentQualificationButton');
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
  const accountFeedback = document.querySelector('#accountFeedback');
  const adminSummaryNote = document.querySelector('#adminSummaryNote');
  const qualificationPanel = document.querySelector('#qualificationPanel');
  const qualificationCapacityLabel = document.querySelector('#qualificationCapacityLabel');
  const startQualificationButton = document.querySelector('#startQualificationButton');
  const qualificationConfirmDialog = document.querySelector('#qualificationConfirmDialog');
  const qualificationConfirmText = document.querySelector('#qualificationConfirmText');
  const confirmQualificationButton = document.querySelector('#confirmQualificationButton');
  const cancelQualificationConfirmButton = document.querySelector('#cancelQualificationConfirmButton');
  const qualificationLive = document.querySelector('#qualificationLive');
  const qualificationLiveState = document.querySelector('#qualificationLiveState');
  const qualificationLiveElapsed = document.querySelector('#qualificationLiveElapsed');
  const qualificationLiveDetail = document.querySelector('#qualificationLiveDetail');
  const qualificationLiveMetrics = document.querySelector('#qualificationLiveMetrics');
  const qualificationFeedback = document.querySelector('#qualificationFeedback');

  const tokenStorageKey = 'ima-qa-admin-token';
  let token = sessionStorage.getItem(tokenStorageKey) || '';
  let bootstrap = null;
  let operations = null;
  let operationsReceivedAt = 0;
  let operationsSignature = "";
  let matchExistingAccount = false;
  let accounts = [];
  let eligibilitySnapshot = null;
  let enrollment = null;
  let enrollmentPollTimer = null;
  let enrollmentPollSequence = 0;
  let enrollmentQrUrl = '';
  let completedEnrollmentTaskId = '';
  let enrollmentReauthAccountId = '';
  let exercise = null;
  let activeExercise = null;
  let exerciseReports = [];
  let exercisePollTimer = null;
  let qualification = null;
  let activeQualification = null;
  let qualificationPollTimer = null;
  let qualificationTarget = null;
  let qualificationStarting = false;
  let observedQualificationRunId = '';
  let observedQualificationResult = null;
  let membershipContinuing = false;
  const accountActionsInFlight = new Set();
  const accountActionFeedback = new Map();
  const accountDrawer = document.querySelector('#accountDrawer');
  const accountDrawerContent = document.querySelector('#accountDrawerContent');
  const identityConflict = document.querySelector('#enrollmentIdentityConflict');
  const identityConflictName = document.querySelector('#identityConflictName');
  const addConflictIdentityButton = document.querySelector('#addConflictIdentityButton');
  let selectedAccountId = '';
  let drawerTrigger = null;
  let drawerBodyOverflow='';
  let identityAdditionInFlight = false;
  let enrollmentCancellationInFlight = false;
  let enrollmentRevision = 0;

  document.querySelector('#closeAccountDrawer').addEventListener('click', () => accountDrawer.close());
  accountDrawer.addEventListener('cancel', event => {
    event.preventDefault();
    accountDrawer.close();
  });
  accountDrawer.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...accountDrawer.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), summary, [tabindex="0"]')].filter(el=>el.getClientRects().length>0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first?.focus();
    }
  });
  accountDrawer.addEventListener('close', () => {
    document.body.style.overflow=drawerBodyOverflow;
    accountList.querySelectorAll('.selected').forEach(row => row.classList.remove('selected'));
    const trigger = [...accountList.querySelectorAll('[data-account-id]')]
      .find(button => button.dataset.accountId === selectedAccountId);
    accountCountLabel.tabIndex = -1;
    (panel.hidden ? tokenInput : trigger || (drawerTrigger?.isConnected && drawerTrigger) || accountCountLabel).focus();
  });
  document.addEventListener('click', event => {
    document.querySelectorAll('.admin-more[open]').forEach(menu => {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });
  document.querySelector('#adminNavigation').addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link || !link.dataset.view) return;
    event.preventDefault();
    window.history.replaceState(null, '', link.getAttribute('href'));
    window.scrollTo({top:0,behavior:'instant'});
    document.body.dataset.view = link.dataset.view;
    document.querySelector('#workspaceTitle').textContent = link.textContent.replace(/[◫▤✓↗⌘]/g, '').trim();
    if (link.dataset.view === 'qualification') void loadQualificationReports();
    document.querySelectorAll('#adminNavigation a').forEach(item => item.removeAttribute('aria-current'));
    link.setAttribute('aria-current', 'page');
  });
  addAccountButton.addEventListener('click', () => openEnrollmentDialog());
  document.querySelector('#restoreAnyAccountButton').addEventListener('click', () => {
    openEnrollmentDialog();
    if (!enrollmentDialog.open || isActiveEnrollment()) return;
    matchExistingAccount = true;
    enrollmentName.hidden = true; enrollmentName.required = false;
    enrollmentName.previousElementSibling.hidden = true;
    replaceEnrollment.parentElement.hidden = true;
    document.querySelector('#reactivateMatchedRow').hidden = false;
    enrollmentDialogTitle.textContent = '扫码恢复任意已有账号';
    enrollmentDialogDescription.textContent = '无需预选原账号；扫码后只更新身份匹配的已有账号，不改名、不换绑历史。';
    enrollmentQualificationNotice.textContent = '勾选恢复调度时最多授权 1 次真实资格问答；不勾选只更新登录态。';
    createEnrollmentButton.focus();
  });
  document.querySelector('#accountSearch').addEventListener('input', renderAccounts);
  document.querySelector('#accountFilter').addEventListener('change', renderAccounts);
  document.querySelector('#cancelQualificationButton').addEventListener('click', async () => {
    const id = activeQualification?.runId || activeQualification?.id; if (!id) return;
    if (!window.confirm('停止后续资格请求？已发出的请求不代表上游已取消。')) return;
    try { await request(`/api/admin/qualifications/${encodeURIComponent(id)}`, { method: 'DELETE' }); await pollQualification(); }
    catch (error) { setFeedback(qualificationFeedback, qualificationErrorText(error), true); }
  });
  continueMembershipButton.addEventListener('click', () => void continueMembership());
  retryEnrollmentQualificationButton.addEventListener('click', () => openQualificationConfirmation(enrollment?.account));
  addConflictIdentityButton.addEventListener('click', () => void resolveConflictIdentity());

  tokenInput.value = token;
  tokenForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    token = tokenInput.value.trim();
    await loadAdminState();
  });
  reloadButton.addEventListener('click', () => loadAdminState());
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
  startQualificationButton.addEventListener('click', () => openQualificationConfirmation());
  confirmQualificationButton.addEventListener('click', () => void confirmQualificationStart());
  cancelQualificationConfirmButton.addEventListener('click', () => qualificationConfirmDialog.close());
  enrollmentDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (isActiveEnrollment()) {
      void cancelEnrollment();
      return;
    }
    void closeEnrollmentDialog();
  });

  const operationsPoller = typeof AdminPoller === 'function' ? new AdminPoller({
    read: signal => request('/api/admin/overview', { signal }),
    accept: payload => acceptOperations(payload.overview),
    fail: () => { document.querySelector('#refreshStatus').textContent = '读取中断；超过 15 秒将显示未知'; },
  }) : null;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void operationsPoller?.refresh(); });
  window.addEventListener('pagehide', () => operationsPoller?.close());
  let staleTimer;
  const checkStaleness = () => {
    if(monitorStatus&&Date.now()-monitorStatus.observedAt>15000)renderServiceHero();
    if (operations && Date.now() - Date.parse(operations.observedAt) > 15000) {
      document.querySelector('#refreshStatus').textContent = '状态已过期 · 当前状态未知';
      document.querySelector('#overviewSection').classList.add('operations-stale');
      setHero('unknown','状态已过期','刷新状态后再进行维护');
      document.querySelectorAll('#attentionAccounts button').forEach(b=>b.disabled=true);
      for (const el of summary.querySelectorAll('strong')) el.textContent = '—';
      adminSummaryNote.textContent='运行快照已过期 容量尚未确认 请刷新状态';
      document.querySelectorAll('#accountList .status-chip').forEach(chip=>{chip.textContent='状态过期';chip.dataset.state='unknown';});
      document.querySelectorAll('#accountList .account-row-actions button, #accountDrawerContent .drawer-actions button').forEach(button=>button.disabled=true);
      accountDrawerContent.dataset.stale='true';
      addAccountButton.disabled=true;document.querySelector('#restoreAnyAccountButton').disabled=true;
    }
  };
  staleTimer = window.setInterval(checkStaleness, 1000);
  window.addEventListener('pageshow', event => { if (event.persisted) { void operationsPoller?.start(); staleTimer = window.setInterval(checkStaleness, 1000); } });
  window.addEventListener('pagehide', () => window.clearInterval(staleTimer));
  void loadAdminState();

  async function loadAdminState() {
    setFeedback(loginFeedback, '');
    reloadButton.disabled = true;
    try {
      const [bootstrapPayload, accountPayload, eligibilityPayload] = await Promise.all([
        request('/api/admin/bootstrap'),
        request('/api/admin/accounts?details=1'),
        request('/api/admin/v2/accounts/eligibility').catch(() => null),
      ]);
      bootstrap = bootstrapPayload;
      if(bootstrap.operations?.statusPageUrl)document.querySelector('#statusPageLink').href=bootstrap.operations.statusPageUrl;
      document.querySelector('#syntheticNotice').hidden = bootstrap.provider !== 'synthetic-preview';
      if(bootstrap.provider==='synthetic-preview'&&!document.querySelector('#previewScenario')){
        const select=document.createElement('select');select.id='previewScenario';select.setAttribute('aria-label','合成状态场景');
        for(const [value,label] of Object.entries({degraded:'容量下降',normal:'全部正常',busy:'繁忙排队',outage:'在线故障',storage:'保存保护',unknown:'未知状态',qualification:'待验证资格'})){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}
        select.addEventListener('change',async()=>{select.disabled=true;try{await request('/api/preview/scenario',{method:'POST',body:JSON.stringify({scenario:select.value})});await loadAdminState();await recentPoller?.refresh();}finally{select.disabled=false;}});
        document.querySelector('#syntheticNotice').append(' · 切换演示 ',select);
      }
      eligibilitySnapshot = eligibilityPayload;
      const eligibilityById = new Map((eligibilitySnapshot?.accounts || []).map((account) => [account.id, account]));
      accounts = Array.isArray(accountPayload.accounts)
        ? accountPayload.accounts.map((account) => {
          const strategyEligibility = eligibilityById.get(account.id) || null;
          const basicHealth = strategyEligibility?.basic_health;
          return {
            ...account,
            serviceStatus: strategyEligibility?.strategies?.knowledge_agent
              ? knowledgeServiceState(strategyEligibility.strategies.knowledge_agent)
              : account.serviceStatus || 'pending',
            ...(basicHealth ? { availabilityStatus: {
              passed: 'ready', failed: 'unavailable', pending: 'needs_check',
            }[basicHealth.check_status] || 'needs_check' } : {}),
            ...(basicHealth ? { health: { ...account.health, ...basicHealth } } : {}),
            strategyEligibility,
          };
        })
        : [];
      sessionStorage.setItem(tokenStorageKey, token);
      login.hidden = true;
      panel.hidden = false;
      document.querySelector('#adminNavigation').hidden = false;
      renderSummary(accountPayload.summary, accountPayload.queue, eligibilitySnapshot);
      if (operationsPoller) await operationsPoller.refresh();
      addAccountButton.disabled = !bootstrap?.enrollment?.supportsAdminPageQr || Boolean(operations && operations.persistence?.ready !== true);
      document.querySelector('#restoreAnyAccountButton').disabled=addAccountButton.disabled;
      addAccountButton.title = bootstrap?.enrollment?.supportsAdminPageQr
        ? ''
        : '当前服务未启用页面二维码接入';
      renderAccounts();
      qualification = bootstrap?.qualification || null;
      document.querySelector('#qualificationNav').hidden = !qualification;
      activeQualification = qualification?.active || null;
      renderQualification();
      if (activeQualification) pollQualification();
      exercise = bootstrap?.exercise || null;
      document.querySelector('#exerciseNav').hidden = !exercise;
      document.querySelector('#reportsNav').hidden = !exercise;
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
      if (error.statusCode !== 401 && error.statusCode !== 403) {
        document.querySelector('#refreshStatus').textContent = '状态暂时无法确认；保留当前操作，稍后重试';
        return;
      }
      sessionStorage.removeItem(tokenStorageKey);
      token = '';
      tokenInput.value = '';
      login.hidden = false;
      panel.hidden = true;
      document.querySelector('#adminNavigation').hidden = true;
      if (accountDrawer.open) accountDrawer.close();
      stopExercisePolling();
      stopQualificationPolling();
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
      const error = new Error(payload.error || `请求失败 (${response.status})`);
      error.code = payload.code || '';
      error.statusCode = response.status;
      throw error;
    }
    return payload;
  }

  function renderSummary() {
    if (operations) return renderOperations();
    summary.replaceChildren(...['可服务账号','同时回答上限','正在回答','排队等待'].map(x => createMetric(x, '—')));
    adminSummaryNote.textContent = '正在等待运行中 Provider 的一致快照；不使用历史资格推算当前容量。';
  }

  function acceptOperations(value) {
    if (value?.schema !== 'provider_operations_v1' || !Number.isFinite(Date.parse(value.observedAt)) || Date.now()-Date.parse(value.observedAt)>15000) throw Error('stale_operations');
    if(operations && Date.now()-Date.parse(operations.observedAt)>15000)operationsSignature='';
    operations=value; operationsReceivedAt=Date.now();
    delete accountDrawerContent.dataset.stale;
    const byId=new Map(value.rows.map(x=>[x.id,x]));
    if(value.eligibility) eligibilitySnapshot=value.eligibility;
    const eligibilityById=new Map((value.eligibility?.accounts||[]).map(a=>[a.id,a]));
    const previous=new Map(accounts.map(a=>[a.id,a]));
    accounts=(value.accounts||accounts).map(a=>({...previous.get(a.id),...a, strategyEligibility:eligibilityById.get(a.id)||previous.get(a.id)?.strategyEligibility, events:a.events||previous.get(a.id)?.events, operations:byId.get(a.id), serviceStatus:byId.get(a.id)?.ready?'ready':a.serviceStatus}));
    renderOperations();
    if (accountDrawer.open) {
      const selected=accounts.find(a=>a.id===selectedAccountId);
      if(!selected) accountDrawer.close();
      else if(!accountDrawerContent.contains(document.activeElement)) {
        const scroll=accountDrawer.scrollTop, opened=[...accountDrawerContent.querySelectorAll('details')].map(x=>x.open);
        renderAccountDetails(selected); [...accountDrawerContent.querySelectorAll('details')].forEach((x,i)=>x.open=opened[i]||false); accountDrawer.scrollTop=scroll;
      }
    }
    for(const row of accountList.querySelectorAll('tbody tr[data-account-id]')) {
      const r=byId.get(row.dataset.accountId),cells=row.querySelectorAll('td');if(!r||cells.length<4)continue;
      const state=cells[1].querySelector('.status-chip');if(state){state.textContent=rowStateLabel(r);state.dataset.state=rowTone(r);}cells[2].textContent=r.ready?`${r.limit??'—'} 路 · ${basisLabel(r.basis)}`:'不计入容量';
    }
    const signature=JSON.stringify(value.rows);
    if(signature!==operationsSignature && !accountList.contains(document.activeElement) && !accountList.querySelector('details[open]')) {
      operationsSignature=signature; renderAccounts();
    }
  }
  function renderOperations() {
    const v=operations, labels={normal:'服务正常',busy:'名额已满 · 正在排队',degraded:'部分容量可用',outage:'暂不可服务',maintenance:'维护中',unknown:'状态未知'};
    document.querySelector('#overviewSection').classList.remove('operations-stale');
    document.querySelector('#refreshStatus').textContent=`${labels[v.state]||'未知'} · 每 5 秒刷新 · ${new Date(v.observedAt).toLocaleTimeString('zh-CN')}`;
    summary.replaceChildren(createMetric('可服务账号',`${v.ready} / ${v.total}`),createMetric('空闲名额',v.free??'—'),createMetric('正在回答',v.active??'—'),createMetric('排队等待',v.queued??'—'));
    renderServiceHero();renderAttention();
    const canEnroll=bootstrap?.enrollment?.supportsAdminPageQr && v.persistence?.ready===true;
    addAccountButton.disabled=!canEnroll;document.querySelector('#restoreAnyAccountButton').disabled=!canEnroll;
    document.querySelector('#reconcileButton').hidden = v.persistence?.canReconcile !== true;
    const trials=v.rows.filter(x=>x.ready&&x.basis==='operator_trial');
    adminSummaryNote.textContent=`空闲 ${v.free??'—'} 路 · 排队上限 ${v.queueLimit??'—'} · ${trials.length?'含试运行额度，尚非稳定并发验收':'按当前调度限制'}${v.warnings.length?' · '+v.warnings.join('；'):''}`;
    const allocation=document.querySelector('#capacityAllocation');allocation.replaceChildren();
    for(const r of v.rows.filter(x=>x.ready)) {
      const group=document.createElement('div'); group.className='allocation-group';
      const label=document.createElement('p');label.textContent=`${r.name} · ${r.limit??'—'} 路 · ${basisLabel(r.basis)}`;
      const slots=document.createElement('div');slots.className='capacity-slots';
      for(let i=0;i<Math.min(30,r.limit||0);i++){const slot=document.createElement('span');slot.className=i<(r.active||0)?'occupied':'';slots.append(slot);}
      group.append(label,slots);allocation.append(group);
    }
    if(!allocation.childElementCount)allocation.textContent='没有已确认的可服务容量';
    const m=v.metrics;
    document.querySelector('#qaObservation').textContent=m?.samples?`最近一小时（最多 512 个）样本 ${m.samples} · 成功 ${(m.successRate*100).toFixed(1)}% · 完成 P95 ${m.durationP95Ms??'—'} ms · 首段 P95 ${m.firstDeltaP95Ms??'—'} ms`:'尚无样本，不计算成功率或回答延迟';
    const d=document.querySelector('#operationsDiagnostics');d.replaceChildren();
    for(const [key,label] of Object.entries({registered:'登记账号数',accountCapacity:'当前账号容量',readinessCapacity:'网站就绪容量',dispatchCeiling:'队列派发上限',globalCeiling:'全局配置上限'})) {
      const p=document.createElement('p');p.textContent=`${label}：${v.diagnostics?.[key]??'未知'}`;d.append(p);
    }
    const privacy=document.createElement('p');privacy.textContent='自动刷新不检查账号、不续期、不验证资格、不发问。统计在线访客数：未提供。';d.append(privacy);
  }
  function basisLabel(value) { return {validated:'实测验证',operator_trial:'试运行',default:'默认限制',unverified:'依据待核对'}[value]||'未知'; }
  function qualificationFailureLabel(report) {
    if (report?.failureStage === 'qualification_commit' || report?.failureCategory === 'local_persistence_failed') return '资格保存失败；不等同于上游回答失败';
    if (report?.failureCategory === 'local_generation_conflict') return '本地账号状态冲突，资格未提交';
    if (report?.warnings?.includes('pool_sync_failed')) return '资格已保存，调度同步需要核对';
    return report?.failureCategory || '无已报告错误';
  }
  async function loadQualificationReports() {
    const container=document.querySelector('#qualificationReports');
    try {
      const result=await request('/api/admin/qualifications/reports');container.replaceChildren();
      for(const report of (result.reports||[])) {
        const row=document.createElement('div');row.className='qualification-report';
        const label=document.createElement('p');label.textContent=`${report.status||'未知'} · 已用 ${report.usedRequests??'—'} / ${report.authorizedRequests??'—'} 次 · ${qualificationFailureLabel(report)}`;
        row.append(label,createAction('查看资格报告',async()=>{
          try{const r=await request(`/api/admin/qualifications/reports/${encodeURIComponent(report.id||report.runId)}`);
            const detail=document.createElement('pre');detail.textContent=JSON.stringify(r.report,null,2);row.append(detail);}
          catch(error){setFeedback(qualificationFeedback,qualificationErrorText(error),true);}
        }));container.append(row);
      }
      if(!container.childElementCount)container.textContent='暂无已保存的资格报告';
    }catch(error){container.textContent='资格报告暂时无法读取';}
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

  let monitorStatus=null;
  function setHero(state,title,description){
    document.querySelector('#serviceHero').dataset.state=state;
    document.querySelector('#serviceHeadline').textContent=title;
    document.querySelector('#serviceDescription').textContent=description;
  }
  function renderServiceHero(){
    const fresh=monitorStatus && Date.now()-monitorStatus.observedAt<=15000;
    const state=fresh?monitorStatus.state:'unknown';
    const titles={normal:'服务运行正常',degraded:'服务可用 部分账号需维护',busy:'服务繁忙 正在排队',outage:'服务暂不可用',maintenance:'服务维护中',unknown:'服务状态待确认'};
    setHero(state,titles[state]||titles.unknown,fresh?`${operations?.ready??'—'} 个账号可服务 · ${operations?.free??'—'} 个空闲回答名额`:'Provider 快照与在线入口分别检查 不把未知当正常');
  }
  function renderAttention(){
    const root=document.querySelector('#attentionAccounts');if(root.contains(document.activeElement))return;
    root.replaceChildren();const rows=accounts.filter(a=>!a.operations?.ready);document.querySelector('#attentionCount').textContent=rows.length;
    for(const a of rows){const row=document.createElement('div');row.className='attention-row';const dot=document.createElement('span');dot.className='account-symbol';dot.dataset.state=rowTone(a.operations);dot.textContent='◉';
      const text=document.createElement('div'),name=document.createElement('strong'),reason=document.createElement('p');name.textContent=a.name;reason.textContent=a.operations?.reason||'状态尚未确认';text.append(name,reason);row.append(dot,text,targetAction(a));root.append(row);}
    if(!rows.length){const text=document.createElement('p');text.className='attention-empty';text.textContent='当前没有待处理账号';root.append(text);}
  }
  const recentPoller=typeof AdminPoller==='function'?new AdminPoller({
    read:signal=>request('/api/admin/operations/status',{signal}),
    accept:payload=>{
      if(payload.status?.schema!=='provider_status_v1')throw Error('invalid_status');
      monitorStatus=payload.status;renderServiceHero();
      document.querySelector('#recentStamp').textContent=`${new Date(monitorStatus.observedAt).toLocaleTimeString('zh-CN')} 更新`;
      window.RecentStatusView?.render(document.querySelector('#recentStatus'),monitorStatus.recent);
    },fail:()=>{monitorStatus=null;renderServiceHero();document.querySelector('#recentStamp').textContent='监控暂不可达 · 既有记录保留';}
  }):null;
  void recentPoller?.start();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void recentPoller?.refresh();});
  window.addEventListener('pagehide',()=>recentPoller?.close());
  window.addEventListener('pageshow',event=>{if(event.persisted)void recentPoller?.start();});
  document.querySelector('#viewAllAccounts').addEventListener('click',event=>{event.preventDefault();document.querySelector('#adminNavigation a[data-view="accounts"]').click();});
  document.querySelector('#reconcileButton').addEventListener('click',async event=>{
    if(event.currentTarget.disabled || operations?.persistence?.canReconcile!==true)return;
    if(!window.confirm('核对磁盘代际及提交摘要？不会重放原操作或解除资格保护。'))return;
    const button=event.currentTarget;button.disabled=true;
    try{await request('/api/admin/persistence/reconcile',{method:'POST',body:'{}'});document.querySelector('#reconcileFeedback').textContent='核对已完成，请以最新保存状态为准';await loadAdminState();}
    catch{document.querySelector('#reconcileFeedback').textContent='无法证明保存结果；保护保持不变，请查看私有诊断';}
    finally{button.disabled=false;}
  });
  const themeButton=document.querySelector('#themeButton');
  const storedTheme=localStorage.getItem('provider-admin-theme');if(['light','dark'].includes(storedTheme))document.documentElement.dataset.theme=storedTheme;
  themeButton.addEventListener('click',()=>{const dark=document.documentElement.dataset.theme==='dark'||(!document.documentElement.dataset.theme&&window.matchMedia?.('(prefers-color-scheme: dark)').matches);const theme=dark?'light':'dark';document.documentElement.dataset.theme=theme;localStorage.setItem('provider-admin-theme',theme);themeButton.setAttribute('aria-label',theme==='dark'?'切换浅色主题':'切换深色主题');});
  accountDrawer.addEventListener('click',event=>{if(event.target===accountDrawer){const b=accountDrawer.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)accountDrawer.close();}});
  const handle=accountDrawer.querySelector('.sheet-handle');let drag=null;
  handle.addEventListener('pointerdown',event=>{drag={id:event.pointerId,y:event.clientY};handle.setPointerCapture?.(event.pointerId);});
  handle.addEventListener('pointerup',event=>{if(drag?.id===event.pointerId&&event.clientY-drag.y>60)accountDrawer.close();drag=null;});
  handle.addEventListener('pointercancel',()=>drag=null);
  function renderQualification() {
    qualificationPanel.hidden = !qualification;
    if (!qualification) return;
    const targets = Number(qualification.targetAccountCount || 0);
    const budget = Number(qualification.authorizedRequestCount || 0);
    const knowledgeAgentCapacity = Number(eligibilitySnapshot?.summary?.strategies?.knowledge_agent?.capacity
      ?? qualification.knowledgeAgentAvailable ?? 0);
    const currentProfileCapacity = Number(eligibilitySnapshot?.summary?.active_profile_capacity
      ?? qualification.generalAutoAvailable ?? 0);
    const selectedProfile = profileLabel(eligibilitySnapshot?.active_profile?.name || 'ima_agent_auto');
    qualificationCapacityLabel.textContent = `网站当前容量 ${operations?.capacity ?? "待确认"} 路；历史资格折算 ${knowledgeAgentCapacity} 路（可含过期账号）；当前「${selectedProfile}」模式容量 ${currentProfileCapacity} 路；待认证 ${targets} 个账号`;
    startQualificationButton.disabled = Boolean(activeQualification) || targets < 1;
    startQualificationButton.textContent = targets > 0
      ? `认证 ${targets} 个账号（最多 ${budget} 次）`
      : '没有待认证账号';
    document.querySelector('#cancelQualificationButton').hidden = !activeQualification;
    qualificationLive.hidden = !activeQualification;
    if (!activeQualification) return;
    const phase = {
      smoke: '正在执行冒烟检查',
      matrix: '正在执行六模式认证',
      applying: '正在原子写入资格',
      completed: '认证任务已结束',
    }[activeQualification.phase] || '正在认证';
    qualificationLiveState.textContent = phase;
    qualificationLiveElapsed.textContent = `已运行 ${formatDuration(Date.now() - Number(activeQualification.startedAt || Date.now()))}`;
    qualificationLiveDetail.textContent = `普通 Provider 问答已暂停；不会调用 Bot、Android 或微信发送。${qualificationOutcomeNote(activeQualification)}`;
    qualificationLiveMetrics.replaceChildren(
      createMetric('已用额度', Number(activeQualification.usedRequests || 0)),
      createMetric('授权额度', Number(activeQualification.authorizedRequests || 0)),
      createMetric('模式通过', Number(activeQualification.completedModes || 0)),
      createMetric('账号通过', Number(activeQualification.passedTargets || 0)),
      createMetric('账号失败', Number(activeQualification.failedTargets || 0)),
    );
  }

  function enrollmentQualificationBudget() {
    const contract = bootstrap?.enrollment?.qualification;
    return contract?.required === true && contract.automatic === true
      && Number.isSafeInteger(contract.requestsPerTarget) && contract.requestsPerTarget > 0
      ? contract.requestsPerTarget : null;
  }

  function openQualificationConfirmation(account = null) {
    if (qualificationStarting || activeQualification) return;
    qualificationTarget = null;
    if (account?.id) {
      const webVerify = !enrollmentQualificationBudget() && bootstrap?.webVerification?.available === true;
      const budget = enrollmentQualificationBudget() || (webVerify ? 1 : null);
      if (!budget) return;
      qualificationTarget = { id: account.id, budget, webVerify };
      qualificationConfirmText.textContent = `仅验证账号 ${account.name}，授权最多 ${budget} 次真实问答验证；不会复验其他账号。只有服务端确认成功后，待接入资格账号才会自动启用。`;
      qualificationConfirmDialog.showModal();
      return;
    }
    if (!qualification || activeQualification || Number(qualification.targetAccountCount || 0) < 1) return;
    qualificationConfirmText.textContent = `本次将认证 ${qualification.targetAccountCount} 个账号，授权最多 ${qualification.authorizedRequestCount} 次真实 3DGS 问答。只有整批通过才会生效。`;
    qualificationConfirmDialog.showModal();
  }

  async function confirmQualificationStart() {
    if (qualificationStarting || activeQualification || (!qualificationTarget && !qualification)) return;
    const target = qualificationTarget;
    if (target && target.budget !== (enrollmentQualificationBudget() || (target.webVerify && bootstrap?.webVerification?.available ? 1 : null))) return;
    qualificationStarting = true;
    qualificationConfirmDialog.close();
    confirmQualificationButton.disabled = true;
    startQualificationButton.disabled = true;
    setFeedback(qualificationFeedback, '正在启动真实知识问答资格认证…');
    try {
      const payload = await request(target ? `/api/admin/accounts/${encodeURIComponent(target.id)}/${target.webVerify ? 'verify' : 'qualification'}` : '/api/admin/qualifications', {
        method: 'POST',
        body: JSON.stringify(target ? { confirm: true, authorizedRequestCount: target.budget } : {
          confirm: true,
          authorizedRequestCount: qualification.authorizedRequestCount,
          candidateSetDigest: qualification.candidateSetDigest,
        }),
      });
      if (target?.webVerify) {
        setFeedback(accountFeedback, payload.success ? '本账号资格验证完成；请核对保存与派发状态' : '本账号资格验证未通过；未自动重试', !payload.success);
        await loadAdminState(); return;
      }
      activeQualification = target ? payload.qualification : payload.run;
      observedQualificationRunId = activeQualification?.runId || activeQualification?.id || '';
      observedQualificationResult = activeQualification;
      if (target && enrollmentDialog.open && !isActiveEnrollment()) dismissEnrollmentDialog();
      renderQualification();
      pollQualification();
    } catch (error) {
      setFeedback(qualificationFeedback, qualificationErrorText(error), true);
      if (target && enrollmentDialog.open) setFeedback(enrollmentDialogFeedback, qualificationErrorText(error), true);
      startQualificationButton.disabled = false;
    } finally {
      qualificationStarting = false;
      qualificationTarget = null;
      confirmQualificationButton.disabled = false;
    }
  }

  async function pollQualification() {
    stopQualificationPolling();
    if (document.hidden) { qualificationPollTimer = window.setTimeout(() => void pollQualification(), 5000); return; }
    try {
      const payload = await request('/api/admin/qualifications/active');
      activeQualification = payload.run || null;
      if (activeQualification) {
        observedQualificationRunId ||= activeQualification.runId || activeQualification.id || '';
        if ((activeQualification.runId || activeQualification.id) === observedQualificationRunId) observedQualificationResult = activeQualification;
        renderQualification();
        qualificationPollTimer = window.setTimeout(() => void pollQualification(), 900);
        return;
      }
      const refreshed = await request('/api/admin/qualifications/bootstrap');
      const reports = await request('/api/admin/qualifications/reports');
      const storedReport = Array.isArray(reports.reports)
        ? reports.reports.find(item => item.id === observedQualificationRunId) : null;
      const report = storedReport || observedQualificationResult;
      qualification = refreshed.qualification;
      renderQualification();
      setFeedback(qualificationFeedback, report
        ? `资格报告：${report.status || '状态未知'}；已用 ${report.usedRequests ?? '未知'} / 授权 ${report.authorizedRequests ?? '未知'} 次${report.failureCategory ? `；失败类别：${report.failureCategory}` : ''}${qualificationOutcomeNote(report)}${storedReport ? '' : '；尚未取得持久化报告，以最后一次观察为准。'}`
        : '资格任务已结束，尚未取得对应报告；请以账号池实际资格为准。');
      observedQualificationRunId = '';
      observedQualificationResult = null;
      await loadAdminState();
    } catch (error) {
      setFeedback(qualificationFeedback, qualificationErrorText(error), true);
    }
  }

  function stopQualificationPolling() {
    if (qualificationPollTimer) {
      window.clearTimeout(qualificationPollTimer);
      qualificationPollTimer = null;
    }
  }

  function qualificationErrorText(error) {
    return {
      qualification_authorization_invalid: '账号集合或授权额度已变化，请刷新后重新确认。',
      provider_requests_not_drained: '仍有 Provider 问答在处理，请等待归零后重试。',
      provider_maintenance_conflict: '另一个维护任务正在运行，请等待完成。',
      qualification_no_candidates: '当前没有需要认证的账号。',
    }[error?.message] || error?.message || '资格认证失败';
  }

  function openEnrollmentDialog(account = null) {
    if (!bootstrap?.enrollment?.supportsAdminPageQr) {
      setFeedback(enrollFeedback, '当前服务未启用页面二维码接入', true);
      return;
    }
    if (accountDrawer.open) accountDrawer.close();
    const activeEnrollment = bootstrap?.enrollment?.activeEnrollment;
    if (activeEnrollment && isActiveEnrollmentState(activeEnrollment.state)) {
      enrollment = activeEnrollment;
      enrollmentForm.hidden = true;
      enrollmentProgress.hidden = false;
      renderEnrollment();
    } else {
      resetEnrollmentDialog();
      if (account) {
        enrollmentReauthAccountId = account.id;
        enrollmentDialogTitle.textContent = `重新登录 ${account.name}`;
        enrollmentDialogDescription.textContent = '新登录态验证通过且确认属于原 IMA 身份后，才会原位替换旧凭据';
        enrollmentName.value = account.name;
        enrollmentName.disabled = true;
        replaceEnrollment.checked = true;
        replaceEnrollment.disabled = true;
        createEnrollmentButton.textContent = '打开重新登录窗口';
      }
    }
    enrollmentDialog.showModal();
    const budget = enrollmentQualificationBudget();
    enrollmentQualificationNotice.hidden = bootstrap?.enrollment?.qualification?.required !== true;
    enrollmentQualificationNotice.textContent = budget
      ? `授权后将自动进行最多${budget}次真实问答验证，仅验证本次账号。点击接入表示同意。`
      : '资格验证授权配置不可用，请刷新后重试。';
    createEnrollmentButton.disabled = !enrollmentQualificationNotice.hidden && !budget;
    if (budget) createEnrollmentButton.textContent = '同意并接入';
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
    if (createEnrollmentButton.disabled) return;
    const budget = enrollmentQualificationBudget();
    if (bootstrap?.enrollment?.qualification?.required === true && !budget) return;
    setFeedback(enrollmentDialogFeedback, '');
    createEnrollmentButton.disabled = true;
    try {
      const preflight = await request('/api/admin/enrollment-preflight', { method: 'POST' });
      if (!preflight.enrollment?.ready) throw new Error('扫码通路未就绪；未创建接入任务，请先检查维护助手');
      const payload = await request('/api/admin/enrollments', {
        method: 'POST',
        body: JSON.stringify({
          ...(matchExistingAccount ? { matchExistingAccount: true, reactivateMatchedAccount: document.querySelector('#reactivateMatchedAccount').checked,
            confirmQualification: document.querySelector('#reactivateMatchedAccount').checked, authorizedRequestCount: document.querySelector('#reactivateMatchedAccount').checked ? 1 : undefined } : budget ? { confirmQualification: true, authorizedRequestCount: budget } : {}),
          ...(matchExistingAccount ? {} : enrollmentReauthAccountId
            ? { reauthAccountId: enrollmentReauthAccountId }
            : {
                name: cleanAccountName(enrollmentName.value),
                replace: replaceEnrollment.checked,
              }),
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
    stopEnrollmentPolling();
    if (document.hidden) { enrollmentPollTimer = window.setTimeout(() => void refreshEnrollment(), 5000); return; }
    if (!enrollment?.taskId || identityAdditionInFlight || enrollmentCancellationInFlight) {
      return;
    }
    const taskId = enrollment.taskId;
    const revision = enrollmentRevision;
    const sequence = ++enrollmentPollSequence;
    try {
      const payload = await request(`/api/admin/enrollments/${encodeURIComponent(taskId)}`);
      if (revision !== enrollmentRevision || sequence !== enrollmentPollSequence || enrollment?.taskId !== taskId) return;
      if (payload.enrollment?.taskId !== taskId) throw new Error('接入响应不匹配，请刷新任务状态');
      enrollment = payload.enrollment;
      if (!isActiveEnrollment()) {
        enrollmentRevision++;
        renderEnrollment();
        if (enrollment.state === 'completed') await finishCompletedEnrollment(enrollment);
        return;
      }
      renderEnrollment();
      if (enrollment.qrAvailable) {
        await refreshEnrollmentQr();
      }
      if (sequence !== enrollmentPollSequence || enrollment?.taskId !== taskId || revision !== enrollmentRevision) return;
      if (isActiveEnrollment()) {
        enrollmentPollTimer = window.setTimeout(() => void refreshEnrollment(), 1200);
      }
    } catch (error) {
      if (revision !== enrollmentRevision || sequence !== enrollmentPollSequence || enrollment?.taskId !== taskId) return;
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
    dismissEnrollmentDialog();
    setFeedback(enrollFeedback, enrollmentCompletionText(completedEnrollment));
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
    identityConflict.hidden = enrollment.state !== 'identity_conflict';
    const canAddIdentity = !matchExistingAccount && (enrollment.identityConflict?.actions || ['add']).includes('add');
    identityConflictName.hidden = !canAddIdentity; addConflictIdentityButton.hidden = !canAddIdentity;
    document.querySelector('#identityConflictTitle').textContent = canAddIdentity ? '扫码身份与原账号不一致' : '未能确认已有账号；原账号池未修改';
    addConflictIdentityButton.disabled = !canAddConflictIdentity() || identityAdditionInFlight || enrollmentCancellationInFlight;
    identityConflictName.disabled = identityAdditionInFlight || enrollmentCancellationInFlight;
    enrollmentStatusText.textContent = enrollmentStatus(enrollment);
    const evidence = enrollment.qualification;
    enrollmentQualificationStatus.hidden = !evidence;
    const qualificationStatus = { pending: '等待验证', running: '正在验证', succeeded: '验证成功', failed: '验证失败', cancelled: '验证已取消' };
    enrollmentQualificationStatus.textContent = evidence
      ? `资格验证：${qualificationStatus[evidence.status] || '状态未知'}；已用 ${evidence.usedRequests ?? '未知'} / 授权 ${evidence.authorizedRequestCount ?? '未知'} 次${evidence.failureCategory ? `；失败类别：${evidence.failureCategory}` : ''}${qualificationOutcomeNote(evidence)}` : '';
    continueMembershipButton.hidden = enrollment.canContinue !== true;
    continueMembershipButton.disabled = membershipContinuing;
    enrollmentShareLink.hidden = true;
    enrollmentShareLink.removeAttribute('href');
    try {
      const url = new URL(enrollment.shareUrl);
      if (url.protocol === 'https:' && url.hostname === 'ima.qq.com' && !url.username && !url.password && !url.port) {
        enrollmentShareLink.href = url.href;
        enrollmentShareLink.hidden = false;
      }
    } catch {}
    retryEnrollmentQualificationButton.hidden = enrollment.state !== 'failed'
      || !enrollment.account?.id || evidence?.status !== 'failed' || !enrollmentQualificationBudget();
    cancelEnrollmentButton.hidden = !active;
    enrollmentQr.hidden = !enrollment.qrAvailable || useVisibleBrowser || enrollment.state === 'identity_conflict';
    enrollmentQrNote.hidden = enrollmentQr.hidden;
    enrollmentResult.hidden = !enrollment.account;
    renderEnrollmentDiagnostic(enrollment.diagnostics);
    focusEnrollmentWindowButton.hidden = !active || (!browserWindowAvailable && !enrollment.diagnostics?.browserFallbackAvailable);
    focusEnrollmentWindowButton.textContent = browserWindowAvailable ? '定位受控登录窗口' : '打开受控登录窗口';
    enrollmentResult.textContent = enrollment.account
      ? `账号 ${enrollment.account.name} ${enrollment.state === 'completed' ? '已接入' : '流程尚未完成'}，当前状态：${statusLabel(enrollment.account.status)}。`
      : '';
    if (enrollment.error && enrollment.state !== 'cancelled') {
      setFeedback(enrollmentDialogFeedback, enrollment.error, true);
    }
    if (!active && enrollment.state === 'completed') {
      setFeedback(enrollmentDialogFeedback, enrollmentCompletionText(enrollment));
    }
  }

  function enrollmentCompletionText(job) {
    const accountName = String(job?.account?.name || '新账号');
    const status = job?.account?.status === 'disabled'
      ? '接入流程完成，账号已停用；' : '已接入账号池；';
    const fallback = job?.account?.status === 'disabled'
      ? '仍保持停用；启用需另行确认。' : '知识问答资格以独立认证结果为准。';
    return `账号 ${accountName} ${status}${job?.detail || fallback}${qualificationOutcomeNote(job?.qualification)}`;
  }

  function qualificationOutcomeNote(evidence) {
    if (!evidence) return '';
    const warnings = Array.isArray(evidence.warnings) ? evidence.warnings : [];
    const syncPending = warnings.includes('pool_sync_failed') || warnings.includes('capacity_sync_failed');
    const notes = [];
    if (evidence.commitApplied === true) {
      notes.push(syncPending ? '资格已保存，调度同步需处理' : '资格已保存；能否问答以当前调度资格为准');
    } else {
      if (evidence.commitApplied === false) notes.push('资格尚未确认保存');
      if (syncPending) notes.push('调度同步需处理');
    }
    if (evidence.reportPersisted === false || warnings.includes('report_persistence_failed')) {
      notes.push('报告未持久化，刷新后可能不可见；无需仅因此重试，不会自动重新发起问答验证');
    }
    return notes.length ? `；${notes.join('；')}。` : '';
  }

  async function continueMembership() {
    if (!enrollment?.taskId || enrollment.canContinue !== true || membershipContinuing || enrollmentCancellationInFlight) return;
    const taskId = enrollment.taskId;
    const revision = ++enrollmentRevision;
    membershipContinuing = true;
    stopEnrollmentPolling();
    renderEnrollment();
    try {
      const pending = request(`/api/admin/enrollments/${encodeURIComponent(taskId)}/continue`, { method: 'POST' });
      // Continue may await all seven probes; observe the job while the POST is pending.
      void refreshEnrollment();
      const payload = await pending;
      if (revision !== enrollmentRevision || enrollment?.taskId !== taskId || !isActiveEnrollment()) return;
      if (payload.enrollment?.taskId !== taskId) throw new Error('接入响应不匹配，请刷新任务状态');
      enrollmentRevision++;
      stopEnrollmentPolling();
      enrollment = payload.enrollment;
      renderEnrollment();
      if (enrollment.state === 'completed') await finishCompletedEnrollment(enrollment);
      else if (isActiveEnrollment()) await refreshEnrollment();
    } catch (error) {
      if (revision === enrollmentRevision && enrollment?.taskId === taskId && isActiveEnrollment()) {
        setFeedback(enrollmentDialogFeedback, error.message || '无法继续验证', true);
      }
    } finally {
      membershipContinuing = false;
      continueMembershipButton.disabled = false;
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
    if (enrollmentCancellationInFlight) return;
    if (!enrollment?.taskId || !isActiveEnrollment()) {
      dismissEnrollmentDialog();
      return;
    }
    const taskId = enrollment.taskId;
    const closeDialog = Boolean(options.closeDialog);
    enrollmentCancellationInFlight = true;
    enrollmentRevision++;
    stopEnrollmentPolling();
    cancelEnrollmentButton.disabled = true;
    renderEnrollment();
    try {
      const payload = await request(`/api/admin/enrollments/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
      });
      if (payload.enrollment?.taskId !== taskId) throw new Error('取消响应不匹配，请刷新任务状态');
      enrollment = payload.enrollment;
      if (enrollment.state === 'completed') {
        await finishCompletedEnrollment(enrollment);
        return;
      }
      if (enrollment.state !== 'cancelled') throw new Error('任务尚未确认取消，请核对当前状态');
      if (closeDialog) {
        dismissEnrollmentDialog();
        setFeedback(enrollFeedback, '未完成的账号接入已取消。');
        await loadAdminState();
      } else {
        renderEnrollment();
        stopEnrollmentPolling();
        revokeEnrollmentQr();
        dismissEnrollmentDialog();
      }
    } catch (error) {
      setFeedback(enrollmentDialogFeedback, error.message || '无法取消接入，请重试', true);
    } finally {
      enrollmentCancellationInFlight = false;
      cancelEnrollmentButton.disabled = false;
      renderEnrollment();
      if (isActiveEnrollment() && !identityAdditionInFlight) {
        enrollmentPollTimer = window.setTimeout(() => void refreshEnrollment(), 1200);
      }
    }
  }

  function canAddConflictIdentity() {
    return enrollment?.state === 'identity_conflict'
      && Array.isArray(enrollment.identityConflict?.actions)
      && enrollment.identityConflict.actions.includes('add');
  }

  async function resolveConflictIdentity() {
    if (matchExistingAccount || (enrollment?.identityConflict?.actions && !enrollment.identityConflict.actions.includes('add'))) return;
    if (!canAddConflictIdentity() || identityAdditionInFlight || enrollmentCancellationInFlight) return;
    const name = cleanAccountName(identityConflictName.value);
    if (!name || name === cleanAccountName(enrollment.name)
        || accounts.some(account => [account.name, account.id].some(value => cleanAccountName(value) === name))) {
      setFeedback(enrollmentDialogFeedback, '请输入与现有账号不同的新账号名称', true);
      return;
    }
    identityAdditionInFlight = true;
    const revision = ++enrollmentRevision;
    const taskId = enrollment.taskId;
    stopEnrollmentPolling();
    setFeedback(enrollmentDialogFeedback, '正在提交新增身份决定...');
    renderEnrollment();
    try {
      const payload = await request(`/api/admin/enrollments/${encodeURIComponent(taskId)}/identity`, {
        method: 'POST', body: JSON.stringify({ action: 'add', name }),
      });
      if (revision !== enrollmentRevision || enrollment?.taskId !== taskId || !isActiveEnrollment()) return;
      if (payload.enrollment?.taskId !== taskId) throw new Error('接入响应不匹配，请刷新任务状态');
      enrollment = payload.enrollment;
      setFeedback(enrollmentDialogFeedback, '');
      renderEnrollment();
      if (enrollment.state === 'completed') await finishCompletedEnrollment(enrollment);
    } catch (error) {
      if (revision === enrollmentRevision && enrollment?.taskId === taskId && isActiveEnrollment()) {
        setFeedback(enrollmentDialogFeedback, error.message || '新增身份失败，请重试或取消', true);
      }
    } finally {
      identityAdditionInFlight = false;
      renderEnrollment();
      if (revision === enrollmentRevision && isActiveEnrollment()) {
        enrollmentPollTimer = window.setTimeout(() => void refreshEnrollment(), 1200);
      }
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
    matchExistingAccount=false;
    document.querySelector('#reactivateMatchedRow').hidden=true;
    document.querySelector('#reactivateMatchedAccount').checked=false;
    enrollmentName.hidden=false; enrollmentName.required=true;
    enrollmentName.previousElementSibling.hidden=false;
    replaceEnrollment.parentElement.hidden=false;
    enrollmentRevision++;
    stopEnrollmentPolling();
    revokeEnrollmentQr();
    enrollment = null;
    enrollmentReauthAccountId = '';
    completedEnrollmentTaskId = '';
    enrollmentForm.reset();
    enrollmentDialogTitle.textContent = '接入 IMA 账号';
    enrollmentDialogDescription.textContent = '将打开独立 IMA 登录窗口，不使用本机微信快捷登录';
    enrollmentName.disabled = false;
    replaceEnrollment.disabled = false;
    createEnrollmentButton.textContent = '打开 IMA 登录窗口';
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
    identityConflict.hidden = true;
    identityConflictName.value = '';
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
    return ['launching_browser', 'loading_ima', 'opening_login', 'waiting_for_qr', 'waiting_for_scan', 'browser_fallback', 'verifying', 'qualifying', 'identity_conflict', 'waiting_for_membership', 'access_unverified'].includes(state);
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
      qualifying: '正在进行真实问答资格验证',
      identity_conflict: '等待确认新身份',
      waiting_for_membership: '等待知识库授权',
      access_unverified: '知识库权限尚未确认',
      completed: '账号接入完成',
      failed: '账号接入失败',
      cancelled: '已取消接入',
    }[state] || '正在处理';
  }

  function enrollmentStatus(current) {
    if (current.state === 'identity_conflict') {
      return current.detail || '本次扫码身份不同，尚未新增账号，等待明确决定。';
    }
    if (['waiting_for_membership', 'access_unverified'].includes(current.state)) {
      return current.detail || '共享知识库访问权限尚未确认；账号尚未保存。';
    }
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
    if (current.state === 'qualifying') return '正在验证本次账号的真实问答资格，尚未完成接入。';
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
    if (document.hidden) { exercisePollTimer = window.setTimeout(() => void pollExercise(), 5000); return; }
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

  function rowTone(r) {return r?.ready?'normal':r?.state==='storage'?'outage':r?.state==='unknown'?'unknown':'degraded';}
  function rowStateLabel(r) {return r?.ready?'可服务':({login:'登录到期',qualification:'待验证资格',disabled:'已停用',storage:'保存保护中',cooldown:'冷却中',maintenance:'维护中',unknown:'待确认'}[r?.state]||'待确认');}
  function targetAction(a) {
    const r=a.operations,action=r?.recommendedAction||'inspect';
    const label={refresh:'续期登录',reauth:'扫码恢复',verify:'验证此账号',enable:'确认启用',check:'刷新状态',inspect:'查看诊断'}[action]||'查看详情';
    const button=createAction(r?.ready?'查看详情':label,()=>executeTarget(a,r?.ready?'inspect':action),accountActionsInFlight.has(a.id));button.className='target-action';return button;
  }
  function executeTarget(a,action){
    a=accounts.find(current=>current.id===a.id)||a;
    if(action==='inspect'){openAccountDrawer(a,document.activeElement);return;}
    if(Date.now()-Date.parse(operations?.observedAt)>15000 || !a.operations?.actions?.includes(action)) {setFeedback(accountFeedback,'状态已变化，请刷新后重试',true);return;}
    if(action==='reauth'){document.querySelector('#restoreAnyAccountButton').click();return;}
    if(action==='verify'){openQualificationConfirmation(a);return;}
    const text={refresh:'为此账号请求一次登录续期？不会自动重试。',check:'检查此账号登录状态？不会发起问答或续期。',enable:'启用此账号？服务端会再次检查资格及保存状态。',disable:'停用此账号的新派发？不会取消已发出的请求。'}[action];
    if(text && window.confirm(text))void runAccountAction(a,action);
  }
  function renderAccounts() {
    const search=document.querySelector('#accountSearch').value.trim().toLowerCase(),filter=document.querySelector('#accountFilter').value;
    const filtered=accounts.filter(a=> {const r=a.operations;return (!search||`${a.name} ${a.id}`.toLowerCase().includes(search)) && (filter==='all'||filter==='ready'&&r?.ready||filter==='attention'&&!r?.ready||filter==='expired'&&r?.login==='expired'||filter==='disabled'&&a.status==='disabled');});
    accountCountLabel.textContent=`${accounts.length} 个账号 · 显示 ${filtered.length} 个`;
    accountList.replaceChildren();const table=document.createElement('table');table.className='admin-account-table';
    const head=document.createElement('thead');head.innerHTML='<tr><th>账号</th><th>当前状态</th><th>允许并发</th><th>上次检查</th><th><span class="sr-only">处理操作</span></th></tr>';table.append(head);const body=document.createElement('tbody');table.append(body);
    for(const a of filtered){const r=a.operations,row=document.createElement('tr');row.dataset.accountId=a.id;
      const add=(label,node)=>{const td=document.createElement('td');td.dataset.label=label;if(node instanceof Node)td.append(node);else td.textContent=node;row.append(td);return td;};
      const name=createAction(a.name,()=>openAccountDrawer(a,name));name.dataset.accountId=a.id;name.className='account-name-button';add('账号',name);
      const chip=document.createElement('span');chip.className='status-chip';chip.dataset.state=rowTone(r);chip.textContent=rowStateLabel(r);add('当前状态',chip);
      add('允许并发',r?.ready?`${r.limit??'—'} 路 · ${basisLabel(r.basis)}`:'不计入容量');
      add('上次检查',r?.maintenance?.lastCheckAt?new Date(r.maintenance.lastCheckAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'尚无记录');
      const actions=document.createElement('div');actions.className='account-row-actions';actions.append(targetAction(a),createAccountMenu(a));add('操作',actions);
      if(a.id===selectedAccountId&&accountDrawer.open)row.classList.add('selected');body.append(row);
      const feedback=accountActionFeedback.get(a.id);if(feedback?.message){const note=document.createElement('tr');const td=document.createElement('td');td.colSpan=5;td.textContent=feedback.message;note.append(td);body.append(note);}
    }
    if(filtered.length)accountList.append(table);else{const p=document.createElement('p');p.className='admin-empty';p.textContent='没有符合条件的账号';accountList.append(p);}
  }

  function managementView(account) {
    const management = account.management || {};
    const eligibility = account.strategyEligibility || {};
    const decision = value => value ? { qualified: value.qualified, schedulable: value.schedulable,
      availableNow: value.available_now, reasonCode: value.reason_code,
      proofState: value.proof_state, verifiedAt: value.verified_at } : {};
    const knowledge = { ...decision(eligibility.strategies?.knowledge_agent), ...management.knowledge };
    const activeProfile = management.activeProfile || {
      name: eligibilitySnapshot?.active_profile?.name,
      generation: eligibilitySnapshot?.active_profile?.generation,
      ready: eligibilitySnapshot?.active_profile?.ready,
      profileReasonCode: eligibilitySnapshot?.active_profile?.reason_code,
      ...decision(eligibility.active_profile),
    };
    return { knowledge, activeProfile, schedulable: management.schedulable
      ?? (activeProfile.ready === false ? false : activeProfile.ready === true ? activeProfile.schedulable : undefined),
    web: management.web || {}, session: management.session || {}, maintenance: management.maintenance || {} };
  }

  function booleanLabel(value) { return value === true ? '是' : value === false ? '否' : '未知'; }

  function proofLabel(value) {
    return { qualified: '有效', expiring: '临近到期', expired: '已过期', stale: '代际失效',
      binding_changed: '绑定已变化', invalid: '无效', missing: '缺少证明', not_required: '无需独立证明' }[value] || value || '未知';
  }

  function reasonLabel(value) {
    return value ? `${eligibilityReasonLabel(value)} (${value})` : '未知';
  }

  function stateBadge(state, label) {
    const badge = document.createElement('span');
    badge.className = `admin-state ${['ready', 'pending', 'unavailable'].includes(state) ? state : 'unknown'}`;
    badge.textContent = label || { ready: '可用', unavailable: '不可用' }[state] || '未知';
    return badge;
  }

  function maintenanceDate(value, missing = '未知') {
    if (value == null || value === '') return missing;
    if (Number.isNaN(new Date(value).getTime())) return '未知';
    return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' });
  }

  function maintenanceLabel(state) {
    return { unobserved: '尚无维护记录', idle: '等待巡检', ready: '维护就绪', checking: '检查中',
      refreshing: '续期中', retrying: '重试中', retry_wait: '等待重试', cooling: '冷却中',
      needs_login: '需人工登录', disabled: '已停用', scheduled: '已安排' }[state] || '状态未知';
  }

  function createAccountMenu(account) {
    const menu = document.createElement('details');
    menu.className = 'admin-more';
    const trigger = document.createElement('summary');
    trigger.textContent = '⋯';
    trigger.title = `${account.name}：更多操作`;
    trigger.setAttribute('aria-label', trigger.title);
    trigger.setAttribute('aria-expanded', 'false');
    const items = document.createElement('div');
    items.className = 'admin-more-items';
    items.setAttribute('role', 'group');
    items.setAttribute('aria-label', `${account.name}的操作`);
    const busy = accountActionsInFlight.has(account.id) || Date.now()-Date.parse(operations?.observedAt)>15000;
    const allowed=account.operations?.actions;
    const add = (label, action, disabled = busy, capability) => { if(allowed && capability && !allowed.includes(capability))return;items.append(createAction(label, () => {
      menu.open = false; trigger.focus(); action();
    }, disabled));};
    add('检查登录状态', () => executeTarget(account, 'check'),busy,'check');
    add('续期登录', () => { if (window.confirm('为此账号请求一次登录续期？这不是刷新页面状态。')) void runAccountAction(account, 'refresh'); },busy,'refresh');
    add('扫码恢复任意已有账号', () => document.querySelector('#restoreAnyAccountButton').click(), busy || !bootstrap?.enrollment?.supportsAdminPageQr,'reauth');
    if (enrollmentQualificationBudget() || bootstrap?.webVerification?.available) add('验证本账号资格', () => openQualificationConfirmation(account), busy || Boolean(activeQualification) || qualificationStarting,'verify');
    if (account.management?.knowledge?.state === 'verifying') add('取消本账号验证', async () => {
      if (!window.confirm('停止本次资格验证？不会自动重新提问。')) return;
      try { await request(`/api/admin/accounts/${encodeURIComponent(account.id)}/verify/cancel`, {method:'POST'}); await loadAdminState(); }
      catch(error) { setFeedback(accountFeedback, error.message, true); }
    });
    const pendingAdmission = account.status === 'disabled' && account.runtime?.disabledReason === 'pending_enrollment_qualification';
    if (!account.identityDuplicate && !pendingAdmission) add(account.status === 'disabled' ? '启用' : '停用',
      () => executeTarget(account, account.status === 'disabled' ? 'enable' : 'disable'),busy,account.status==='disabled'?'enable':'disable');
    if (pendingAdmission) add('保持停用（需资格通过）', () => {}, true);
    add('删除', () => deleteAccount(account),busy,'delete');
    menu.append(trigger, items);
    menu.addEventListener('toggle', () => {
      trigger.setAttribute('aria-expanded', String(menu.open));
      if (menu.open) document.querySelectorAll('.admin-more[open]').forEach(other => { if (other !== menu) other.open = false; });
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.open = false; trigger.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); menu.open = true;
        const buttons = [...items.querySelectorAll('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' || (event.key === 'ArrowUp' && index < 0)
          ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    });
    menu.addEventListener('focusout', event => { if (!menu.contains(event.relatedTarget)) menu.open = false; });
    return menu;
  }

  function openAccountDrawer(account, trigger) {
    selectedAccountId = account.id;
    drawerTrigger = trigger;
    renderAccountDetails(account);
    accountList.querySelectorAll('tbody tr').forEach(row => row.classList.toggle('selected', row.contains(trigger)));
    if (!accountDrawer.open) { drawerBodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';accountDrawer.showModal(); }
    document.querySelector('#closeAccountDrawer').focus();
  }

  function renderAccountDetails(account) {
    const view = managementView(account);
    const knowledge = view.knowledge;
    const profile = view.activeProfile;
    const maintenance = view.maintenance;
    document.querySelector('#accountDrawerTitle').textContent = account.name;
    accountDrawerContent.replaceChildren();
    const primary = document.createElement('p');
    primary.className = `admin-account-primary ${accountHealthTone(account)}`;
    primary.textContent = account.operations?.reason || accountPrimaryMessage(account);
    accountDrawerContent.append(primary);
    let sectionIndex=0;
    const addSection = (title, entries) => {
      const section = document.createElement(sectionIndex++===0?'section':'details');
      const heading = document.createElement(section.tagName==='DETAILS'?'summary':'h3'); heading.textContent = title;
      const list = document.createElement('dl');
      for (const [label, value] of entries) {
        const term = document.createElement('dt'); term.textContent = label;
        const detail = document.createElement('dd');
        if (value instanceof Node) detail.append(value); else detail.textContent = value;
        list.append(term, detail);
      }
      section.append(heading, list); accountDrawerContent.append(section);
    };
    if (account.operations) addSection('服务资格', [['登录', {valid:'有效',expired:'已到期',unknown:'未确认'}[account.operations.login]], ['知识库问答', account.operations.qualified?'已通过':'未通过 / 待确认'], ['允许并发', `${account.operations.limit??'未知'} 路`], ['额度依据', basisLabel(account.operations.basis)]]);
    const quick=document.createElement('div');quick.className='drawer-actions';if(account.operations?.actions?.includes('check'))quick.append(createAction('检查登录状态',()=>executeTarget(account,'check'),accountActionsInFlight.has(account.id)));if(account.operations?.actions?.includes('refresh'))quick.append(createAction('续期登录',()=>executeTarget(account,'refresh'),accountActionsInFlight.has(account.id)));quick.append(createAccountMenu(account));if(operations?.persistence?.ready!==true)quick.append(createAction('查看保存诊断',()=>{accountDrawer.close();document.querySelector('#adminNavigation a[data-view="diagnostics"]').click();}));accountDrawerContent.append(quick);
    addSection('Knowledge Agent 资格', [
      ['当前资格', booleanLabel(knowledge.qualified)],
      ['严格验证', booleanLabel(knowledge.strictQualified)],
      ['证明状态', proofLabel(knowledge.proofState)],
      ['资格原因', reasonLabel(knowledge.reasonCode)],
      ['原始验证时间', maintenanceDate(knowledge.verifiedAt)],
      ['策略可调度容量', booleanLabel(knowledge.schedulable)],
      ['策略即时可用', booleanLabel(knowledge.availableNow)],
    ]);
    addSection('当前模式', [
      ['模式', profileLabel(profile.name)], ['配置代次', String(profile.generation ?? '未知')],
      ['模式就绪', booleanLabel(profile.ready)], ['模式原因', reasonLabel(profile.profileReasonCode)],
      ['当前模式资格', booleanLabel(profile.qualified)], ['证明状态', proofLabel(profile.proofState)],
      ['资格原因', reasonLabel(profile.reasonCode)], ['原始验证时间', maintenanceDate(profile.verifiedAt)],
      ['可调度容量', booleanLabel(view.schedulable)], ['即时可用', booleanLabel(profile.ready === false ? false : profile.availableNow)],
    ]);
    addSection('登录与维护', [
      ['通用联网', stateBadge(view.web.state)], ['会话健康', stateBadge(view.session.state)],
      ['维护状态', maintenanceLabel(maintenance.state)],
      ['上次检查', maintenanceDate(maintenance.lastCheckAt)], ['下次自动检查', maintenanceDate(maintenance.nextCheckAt, '未安排')],
      ['下次重试', maintenanceDate(maintenance.nextRetryAt, '未安排')], ['可续期时间', maintenanceDate(maintenance.refreshEligibleAt)],
      ['访问令牌到期', maintenanceDate(maintenance.tokenExpiresAt, '上游未提供')], ['续期凭证到期', maintenanceDate(maintenance.refreshTokenExpiresAt, '上游未提供')],
      ['上次成功续期', maintenanceDate(maintenance.lastSuccessfulRefreshAt)],
    ]);
    addSection('账号记录', [
      ['账号 ID', account.id], ['身份核验', account.identityDuplicate ? '身份重复' : account.identityVerified ? '已确认' : '未确认'],
      ['处理中请求', String(account.activeRequests || 0)],
    ]);
    const facts = document.createElement('div');
    facts.className = 'admin-account-facts';
    facts.append(createAccountFact('基础检查', statusLabel(account.availabilityStatus), accountHealthTone(account)));
    const record=document.createElement('details');const caption=document.createElement('summary');caption.textContent='维护记录';record.append(caption,facts,createAccountHistory(account));accountDrawerContent.append(record);
  }

  function createAction(label, handler, disabled = false, variant = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = Boolean(disabled);
    if (variant) button.dataset.variant = variant;
    button.addEventListener('click', handler);
    return button;
  }

  async function runAccountAction(account, action) {
    if (accountActionsInFlight.has(account.id)) return;
    accountActionsInFlight.add(account.id);
    accountActionFeedback.set(account.id, { message: `${accountActionLabel(action)}中...`, tone: 'neutral' });
    renderAccounts();
    try {
      const payload = await request(`/api/admin/accounts/${encodeURIComponent(account.id)}/${action}`, { method: 'POST', body: '{}' });
      accountActionFeedback.set(account.id, {
        message: payload.operation?.message || `${accountActionLabel(action)}成功`,
        tone: 'success',
      });
      await loadAdminState();
    } catch (error) {
      const message = error.message || '账号操作失败';
      const tone = error.code === 'upstream_temporary' ? 'warning' : 'danger';
      try {
        await loadAdminState();
      } catch {
        // loadAdminState already renders the authentication or transport failure.
      }
      accountActionFeedback.set(account.id, {
        message: `${accountActionLabel(action)}未完成：${message}`,
        tone,
      });
      setFeedback(accountFeedback, message, tone === 'danger');
    } finally {
      accountActionsInFlight.delete(account.id);
      renderAccounts();
    }
  }

  async function deleteAccount(account) {
    if (!window.confirm(`删除账号“${account.name}”？此操作不会删除 IMA 账号本身。`)) {
      return;
    }
    if (accountActionsInFlight.has(account.id)) return;
    accountActionsInFlight.add(account.id);
    accountActionFeedback.set(account.id, { message: '删除中...', tone: 'neutral' });
    renderAccounts();
    try {
      const payload = await request(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
      accountActionFeedback.delete(account.id);
      setFeedback(accountFeedback, payload.operation?.message || '账号已从本机账号池删除。');
      await loadAdminState();
    } catch (error) {
      accountActionFeedback.set(account.id, { message: error.message || '删除失败', tone: 'danger' });
      setFeedback(accountFeedback, error.message || '删除失败', true);
    } finally {
      accountActionsInFlight.delete(account.id);
      renderAccounts();
    }
  }

  function accountPrimaryMessage(account) {
    if (account.identityDuplicate) {
      return '与另一条记录属于同一 IMA 身份，已自动停用且不计入并发。';
    }
    const knowledge = account.strategyEligibility?.strategies?.knowledge_agent;
    if (knowledge) {
      if (knowledge.schedulable) return knowledge.available_now
        ? '知识库问答可调度。登录和通用联网状态见下方独立项目。'
        : `知识库问答资格有效，当前${knowledge.reason_code === 'account_busy' ? '忙碌' : '冷却中'}。`;
      if (knowledge.reason_code === 'account_disabled') return '账号已停用，暂不参与知识库问答调度。';
      return `知识库问答待验证：${eligibilityReasonLabel(knowledge.reason_code)}。`;
    }
    const health = account.health || {};
    const code = accountHealthCode(account);
    const messages = {
      auth_expired: '登录凭据已失效，需要重新登录。',
      auth_rejected: 'IMA 拒绝了当前登录态，需要重新登录。',
      upstream_temporary: 'IMA 服务或网络暂不可用，稍后重新检查。',
      knowledge_base_unavailable: '登录有效，但共享知识库暂不可用。',
      web_context_missing: '本机 IMA 联网上下文尚未就绪。',
      account_not_checked: '尚未完成一次有效检查。',
    };
    if (messages[code]) return messages[code];
    const eligibility = account.strategyEligibility;
    if (account.availabilityStatus === 'ready' && eligibility?.active_profile) {
      const active = eligibility.active_profile;
      if (active.schedulable && active.available_now) {
        return `基础检查通过，且符合当前「${profileLabel(eligibilitySnapshot?.active_profile?.name)}」模式，可调度。`;
      }
      if (active.reason_code === 'profile_qualification_missing'
          && eligibility.strategies?.knowledge_agent?.schedulable) {
        return `基础检查通过；当前「${profileLabel(eligibilitySnapshot?.active_profile?.name)}」模式缺少资格证明，但已有 3DGS Knowledge Agent 资格，不需要重复做知识 Agent 认证。`;
      }
      return `基础检查通过，但当前模式不可立即调度：${eligibilityReasonLabel(active.reason_code)}。`;
    }
    if (account.availabilityStatus === 'ready' && account.schedulerStatus === 'available') {
      return '基础检查通过；当前运行池显示可用，分策略资格详情不可读取。';
    }
    if (account.availabilityStatus === 'ready') {
      return '基础检查通过，当前未进入可领取状态。';
    }
    return health.last_check_message || '账号状态尚未确认。';
  }

  function createAccountFact(label, value, tone = 'neutral') {
    const item = document.createElement('div');
    item.className = `admin-account-fact ${tone}`;
    const key = document.createElement('span');
    key.textContent = label;
    const text = document.createElement('strong');
    text.textContent = value;
    item.append(key, text);
    return item;
  }

  function createAccountHistory(account) {
    const health = account.health || {};
    const history = document.createElement('details');
    history.className = 'admin-account-history';
    const summary = document.createElement('summary');
    summary.textContent = '凭据与检查记录';
    const list = document.createElement('dl');
    const items = [
      ['IMA 身份', account.identityVerified ? '已校验' : '未校验'],
      ['当前模式资格', account.strategyEligibility?.active_profile
        ? `${eligibilityReasonLabel(account.strategyEligibility.active_profile.reason_code)}${account.strategyEligibility.active_profile.verified_at ? ` · ${formatDate(account.strategyEligibility.active_profile.verified_at)}` : ''}`
        : '当前服务未提供分策略详情'],
      ['3DGS Knowledge Agent', strategyStatusDescription(account.strategyEligibility?.strategies?.knowledge_agent)],
      ['刷新能力', health.refreshable ? '可刷新' : '不可刷新'],
      ['最近检查', health.last_check_at
        ? `${formatDate(health.last_check_at)} · ${health.last_check_message || '已完成'}`
        : '尚未检查'],
      ['最近刷新', health.last_refresh_at
        ? `${formatDate(health.last_refresh_at)} · ${healthCodeLabel(health.last_refresh_code)}`
        : '尚未刷新'],
      ['访问令牌', maintenanceDate(account.tokenExpiresAt, '上游未提供')],
      ['刷新令牌', maintenanceDate(account.refreshTokenExpiresAt, '上游未提供')],
    ];
    if (Number(account.activeRequests || 0)) {
      items.push(['处理中', `${account.activeRequests} 个请求`]);
    }
    if (Number(account.cooldownSecondsRemaining || 0)) {
      items.push(['冷却', `${account.cooldownSecondsRemaining} 秒`]);
    }
    if (account.lastError) {
      items.push(['最近运行异常', account.lastError]);
    }
    for (const [label, value] of items) {
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      list.append(term, detail);
    }
    history.append(summary, list);
    return history;
  }

  function accountHealthCode(account) {
    const health = account.health || {};
    if (['auth_expired', 'auth_rejected'].includes(health.last_refresh_code)) {
      return health.last_refresh_code;
    }
    return health.last_check_code || 'account_not_checked';
  }

  function accountHealthTone(account) {
    if (account.serviceStatus === 'ready') return 'success';
    if (account.serviceStatus === 'busy' || account.serviceStatus === 'cooling') return 'warning';
    const code = accountHealthCode(account);
    if (['auth_expired', 'auth_rejected', 'knowledge_base_unavailable'].includes(code)) return 'danger';
    if (['upstream_temporary', 'web_context_missing', 'account_not_checked'].includes(code)) return 'warning';
    return account.availabilityStatus === 'ready' ? 'success' : 'neutral';
  }

  function accountNeedsReauth(account) {
    return account.identityVerified
      && ['auth_expired', 'auth_rejected'].includes(accountHealthCode(account));
  }

  function healthFlagTone(value) {
    return value === true ? 'success' : value === false ? 'danger' : 'neutral';
  }

  function schedulerStatusLabel(account) {
    return {
      available: '可接单',
      busy: '处理中',
      cooling_down: '冷却中',
      unavailable: account.health?.local_schedulable ? '待入池' : '不可接单',
    }[account.schedulerStatus] || '未知';
  }

  function schedulerStatusTone(account) {
    if (account.schedulerStatus === 'available') return 'success';
    if (['busy', 'cooling_down'].includes(account.schedulerStatus)) return 'warning';
    return account.health?.local_schedulable ? 'neutral' : 'danger';
  }

  function healthCodeLabel(code) {
    return {
      ok: '成功',
      auth_expired: '登录态已过期',
      auth_rejected: '登录态被拒绝',
      upstream_temporary: 'IMA 服务或网络暂不可用',
      knowledge_base_unavailable: '知识库不可用',
      web_context_missing: '联网能力未就绪',
    }[code] || code || '结果未知';
  }

  function statusLabel(status) {
    return {
      ready: '基础检查通过',
      needs_check: '待检查',
      unavailable: '不可用',
      disabled: '已停用',
    }[status] || '未知';
  }

  function knowledgeServiceState(decision) {
    if (decision.reason_code === 'account_disabled') return 'disabled';
    if (decision.reason_code === 'account_busy') return 'busy';
    if (decision.reason_code === 'account_cooling_down') return 'cooling';
    return decision.available_now ? 'ready' : 'pending';
  }

  function knowledgeServiceLabel(state) {
    return { ready: '知识库可问答', busy: '处理中', cooling: '冷却中',
      disabled: '已停用', pending: '知识库待验证' }[state] || '状态待确认';
  }

  function profileLabel(profile) {
    return {
      ima_agent_auto: 'IMA Agent 自动',
      ima_agent: 'IMA Agent',
      classic_knowledge: '经典知识库',
    }[profile] || profile || '未选择';
  }

  function eligibilityReasonLabel(code) {
    return {
      ready: '模式已就绪',
      eligibility_unobserved: '尚无资格观察记录',
      schedulable: '资格有效',
      profile_not_ready: '当前回答模式未就绪',
      answer_profile_capability_drift: '当前模式能力与运行时协议不匹配',
      answer_profile_blocked: '当前回答模式被安全门禁暂停',
      answer_profile_not_ready: '当前回答模式尚未就绪',
      account_disabled: '账号已停用',
      account_missing: '账号记录不存在',
      account_not_in_pool: '账号尚未同步到运行池',
      account_busy: '账号正在处理请求',
      account_cooling_down: '账号处于冷却期',
      routing_lane_mismatch: '账号分流车道不匹配此策略',
      retrieval_policy_proof_missing: '缺少该检索策略的资格证明',
      retrieval_policy_proof_stale: '该策略证明与当前能力版本不匹配',
      retrieval_policy_answer_basis_invalid: '该策略证明的回答依据不符合要求',
      profile_qualification_missing: '缺少当前回答模式资格证明',
      profile_qualification_stale: '模式证明与当前能力版本不匹配',
      profile_qualification_invalid: '模式证明无效或回答依据不匹配',
      knowledge_agent_proof_missing: '尚未取得知识 Agent 资格',
      knowledge_agent_proof_invalid: '知识 Agent 资格证明无效',
      knowledge_agent_proof_binding_changed: '账号或知识库绑定已变化',
      knowledge_agent_proof_expired: '知识 Agent 资格已过期',
      knowledge_agent_proof_expiring_runtime_allowed: '资格临近到期；当前运行策略仍允许使用',
      knowledge_agent_proof_expired_runtime_allowed: '证明已过期；当前兼容策略仍允许调度',
    }[code] || '状态待确认';
  }

  function strategyStatusDescription(strategy) {
    if (!strategy) return '没有此策略的资格记录';
    const label = strategy.schedulable
      ? strategy.available_now ? '可调度' : eligibilityReasonLabel(strategy.reason_code)
      : eligibilityReasonLabel(strategy.reason_code);
    const proof = strategy.proof_state === 'expired'
      ? '证明时间已过期'
      : strategy.proof_state === 'expiring'
        ? '证明临近到期'
        : strategy.proof_state === 'qualified'
          ? '证明有效'
          : strategy.proof_state === 'not_required'
            ? '无需单独证明'
            : strategy.proof_state === 'missing'
              ? '尚无证明'
              : '证明状态需核对';
    return `${label} · ${proof}${strategy.verified_at ? ` · ${formatDate(strategy.verified_at)}` : ''}`;
  }

  function currentProfileStatusLabel(account) {
    if (account.management?.activeProfile?.ready === false) {
      return eligibilityReasonLabel(account.management.activeProfile.profileReasonCode);
    }
    const active = account.strategyEligibility?.active_profile;
    if (!active) return schedulerStatusLabel(account);
    if (active.available_now) return '可调度';
    return eligibilityReasonLabel(active.reason_code);
  }

  function currentProfileStatusTone(account) {
    const active = account.strategyEligibility?.active_profile;
    if (!active) return schedulerStatusTone(account);
    if (active.available_now) return 'success';
    if (active.schedulable || ['account_busy', 'account_cooling_down', 'profile_qualification_missing',
      'profile_qualification_stale', 'profile_qualification_invalid'].includes(active.reason_code)) return 'warning';
    return 'neutral';
  }

  function healthFlagLabel(value) {
    return value === true ? '通过' : value === false ? '失败' : '未检查';
  }

  function accountActionLabel(action) {
    return { check: '检查', refresh: '刷新', enable: '启用', disable: '停用' }[action] || '操作';
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
    return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{M}\p{N} _-]+/gu, '-').slice(0, 80);
  }

})();
