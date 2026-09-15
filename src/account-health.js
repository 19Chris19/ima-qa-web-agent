const HEALTH_CODES = Object.freeze({
  auth_expired: '登录态已过期，请重新扫码登录',
  auth_rejected: 'IMA 拒绝了当前登录态，请重新扫码登录',
  upstream_temporary: 'IMA 服务或网络暂时不可用，请稍后重试',
  knowledge_base_unavailable: '当前账号无法访问共享知识库，请确认已加入后重试',
  web_context_missing: '服务端未能建立 IMA Web 会话上下文，请检查账号接入环境',
  account_operation_in_progress: '该账号已有管理操作正在进行，请等待完成后重试',
  account_not_checked: '尚未完成 IMA 会话检查',
  ok: '检查通过',
});

class AccountHealthOperationError extends Error {
  constructor(code, cause) {
    super(HEALTH_CODES[code] || HEALTH_CODES.upstream_temporary);
    this.name = 'AccountHealthOperationError';
    this.code = code;
    this.statusCode = statusCodeForHealthCode(code);
    this.cause = cause;
  }
}

function createAccountHealthError(code, cause) {
  if (cause instanceof AccountHealthOperationError) {
    return cause;
  }
  return new AccountHealthOperationError(code, cause);
}

function classifyAccountHealthError(error, operation = 'check') {
  if (error instanceof AccountHealthOperationError) {
    return error.code;
  }
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();

  if (Object.hasOwn(HEALTH_CODES, code)) {
    return code;
  }

  if (code === 'aborterror' || /health check timed out|timeout|超时/.test(message)) {
    return 'upstream_temporary';
  }
  if (
    /knowledge.?base|知识库|relatedurl|无权访问|没有权限|not.*member|not.*found/.test(message)
  ) {
    return 'knowledge_base_unavailable';
  }
  if (
    /refresh.*(expired|missing)|refresh.*(过期|不可用)|login expired|登录过期|refresh credentials/.test(message)
  ) {
    return 'auth_expired';
  }
  if (/401|403|unauthorized|forbidden|鉴权|未登录|登录失败|token.*invalid|token.*reject/.test(message)) {
    return 'auth_rejected';
  }
  if (/first.?party|client.?context|web.?context|上下文/.test(message)) {
    return 'web_context_missing';
  }
  return 'upstream_temporary';
}

function healthMessage(code) {
  return HEALTH_CODES[code] || HEALTH_CODES.upstream_temporary;
}

function statusCodeForHealthCode(code) {
  if (code === 'account_operation_in_progress') return 409;
  if (code === 'auth_expired' || code === 'auth_rejected' || code === 'knowledge_base_unavailable') return 422;
  if (code === 'web_context_missing') return 500;
  return 502;
}

module.exports = {
  AccountHealthOperationError,
  HEALTH_CODES,
  classifyAccountHealthError,
  createAccountHealthError,
  healthMessage,
};
