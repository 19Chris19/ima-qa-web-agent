'use strict';
const { accountActions, recommendedAction } = require('./operations/actions');

// All inputs are already resident in the Provider. No I/O, renewal or probes here.
const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const min = (...v) => v.every(x => integer(x) !== null) ? Math.min(...v) : null;
function buildOperationsOverview({ management, readiness, queue, persistence, limits = [], maintenance = false, metrics = null, now = Date.now() }) {
  const accounts = management?.accounts || [];
  const states = new Map((readiness?.accounts || []).map(x => [x.id, x]));
  const storage = persistence?.ready === true;
  const storageUnknown = persistence?.ready !== true && persistence?.ready !== false;
  const rows = accounts.map(a => {
    const r = states.get(a.id), m = a.management || {}, health = a.health || {};
    const login = health.session_valid === false || r?.state === 'needs_login' ? 'expired'
      : health.session_valid === true ? 'valid' : 'unknown';
    const disabled = a.status === 'disabled' || r?.state === 'disabled';
    const cooling = ['cooling', 'cooling_down'].includes(r?.state) || a.schedulerStatus === 'cooling_down';
    const qualified = r?.qualified === true;
    const ready = storage && login === 'valid' && !disabled && !cooling && !a.maintenanceOperation
      && (readiness?.mode === 'classic_knowledge' || qualified) && ['ready', 'busy'].includes(r?.state);
    const evidence = limits.find(x => x.id === a.id);
    const limit = ready ? integer(r?.maxConcurrent) : 0;
    const basis = evidence?.effectiveMaxConcurrent === limit && ['validated', 'operator_trial', 'default'].includes(evidence.limitBasis)
      ? evidence.limitBasis : limit > 1 ? 'unverified' : 'default';
    return { id: a.id, name: a.name, login, qualified, ready, active: integer(a.activeRequests),
      limit, available: ready ? integer(r?.availableSlots) : 0, basis,
      validatedLimit: integer(evidence?.validatedMaxConcurrent),
      state: storageUnknown ? 'unknown' : !storage ? 'storage' : disabled ? 'disabled' : a.maintenanceOperation ? 'maintenance'
        : login !== 'valid' ? login === 'expired' ? 'login' : 'unknown' : cooling ? 'cooldown' : r?.imapy && !r.imapy.ready ? 'kernel' : ready ? 'ready' : 'qualification',
      reason: storageUnknown ? '账号保存服务状态尚未确认' : !storage ? '账号保存服务未就绪，暂停新派发' : disabled ? (a.runtime?.disabledReason==='pending_enrollment_qualification' ? '待接入资格未通过，保持停用' : `账号已停用${a.runtime?.disabledReason ? ' · '+String(a.runtime.disabledReason).slice(0,160) : ''}`)
        : a.maintenanceOperation ? '正在维护' : login === 'expired' ? '需要重新登录；历史资格不能代替有效登录'
        : login !== 'valid' ? '登录状态尚未确认' : cooling ? '账号正在冷却'
        : r?.imapy && !r.imapy.ready ? '新内核未就绪：'+({device_context_missing:'缺少本账号设备上下文',catalog_unavailable:'模型目录待核对',default_not_configured:'未设置默认模型',default_unavailable:'默认模型不可用',policy_unavailable:'模型策略保存未确认',account_unavailable:'账号当前不可派发'}[r.imapy.reason]||'能力待核对') : ready ? '可接收当前网站问答' : '尚未满足当前问答资格',
      ...(r?.imapy?{imapy:r.imapy,legacyQualified:qualified}:{}),
      maintenance: m.maintenance || {}, knowledge: m.knowledge || {}, activeProfile: m.activeProfile || null,
    };
  });
  for (const row of rows) {
    const account = accounts.find(a => a.id === row.id);
    row.actions = accountActions(account, row, { storageReady: storage });
    row.recommendedAction = recommendedAction(row, row.actions);
  }
  const rowCapacity = rows.every(x => x.limit !== null) ? rows.reduce((n, x) => n + x.limit, 0) : null;
  const capacity = storage ? min(rowCapacity, readiness?.capacity, queue?.maxConcurrent) : storageUnknown ? null : 0;
  const active = integer(queue?.activeRequests), queued = integer(queue?.queuedRequests);
  const free = storageUnknown ? null : !storage || maintenance ? 0 : capacity === null || active === null ? null
    : min(Math.max(0, capacity - active), readiness?.schedulable);
  const warnings = [];
  if (capacity === null || active === null || queued === null || free === null) warnings.push('部分计数无法确认，缺失不作为零');
  if (readiness?.capacity !== queue?.maxConcurrent || rowCapacity !== readiness?.capacity) warnings.push(readiness?.mode==='imapy_chat_v1'?'新内核按已就绪账号计数，旧路径资格单独保留':'容量来源不一致，按可确认的较小值展示');
  if (!storage && !storageUnknown) warnings.push('持久化保护中，不派发新任务');
  const state = storageUnknown ? 'unknown' : !storage ? 'outage' : maintenance ? 'maintenance' : capacity === null || active === null || queued === null ? 'unknown'
    : capacity === 0 ? 'outage' : free === 0 || queued > 0 ? 'busy' : rows.some(x => !x.ready) ? 'degraded' : 'normal';
  return { schema: 'provider_operations_v1', observedAt: new Date(now).toISOString(), staleAfterMs: 15000,
    mode: readiness?.mode || 'unknown', state, maintenance, total: rows.length, ready: rows.filter(x => x.ready).length,
    needsLogin: rows.filter(x => x.login === 'expired').length, capacity, active, queued, free,
    queueLimit: integer(queue?.queueLimit), rows, warnings, persistence, metrics,
    diagnostics: { ...(readiness?.legacyCapacity!==undefined?{legacyCapacity:readiness.legacyCapacity}:{}),registered: management?.pool?.totalAccounts ?? rows.length, readinessCapacity: integer(readiness?.capacity),
      dispatchCeiling: integer(queue?.maxConcurrent), accountCapacity: rowCapacity,
      globalCeiling: integer(management?.pool?.elasticScheduling?.maxGlobal) },
    onlineUsers: null };
}
// Explicit public whitelist: no names, account IDs, credential dates or upstream content.
function publicOperations(value) {
  return { schema: value.schema, observedAt: value.observedAt, staleAfterMs: 15000, state: value.state,
    maintenance: value.maintenance, total: value.total, ready: value.ready, capacity: value.capacity,
    active: value.active, queued: value.queued, free: value.free, queueLimit: value.queueLimit,
    persistence: { ready: typeof value.persistence?.ready === 'boolean' ? value.persistence.ready : null }, metrics: safeMetrics(value.metrics) };
}
function safeMetrics(q) { return q ? { samples: integer(q.samples), successRate: typeof q.successRate === 'number' && q.successRate >= 0 && q.successRate <= 1 ? q.successRate : null, durationP95Ms: Number.isFinite(q.durationP95Ms) && q.durationP95Ms >= 0 ? q.durationP95Ms : null, firstDeltaP95Ms: Number.isFinite(q.firstDeltaP95Ms) && q.firstDeltaP95Ms >= 0 ? q.firstDeltaP95Ms : null, window: 'last_hour_up_to_512' } : null; }
module.exports = { buildOperationsOverview, publicOperations, safeMetrics };
