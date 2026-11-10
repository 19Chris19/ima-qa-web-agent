'use strict';

// Only fixed labels cross the worker boundary. Never copy exception messages,
// stack traces, account identifiers, paths, headers or credential values.
const phases = new Set(['dispatch', 'store_read', 'draft_load', 'apply_operation',
  'store_commit', 'runtime_export', 'identity_lookup', 'snapshot', 'reconcile', 'statistics']);
const classifications = new Map([
  ['Account not found', ['account_not_found', 'account_missing', 404]],
  ['account_not_found', ['account_not_found', 'account_missing', 404]],
  ['Account maxConcurrent must be a positive integer', ['account_capacity_invalid', 'invalid_capacity', 400]],
  ['IMA_WEB_AGENT_HEADERS_JSON must be valid JSON', ['account_credential_encoding_invalid', 'credential_encoding', 400]],
  ['headers must be an object', ['account_headers_invalid', 'invalid_headers', 400]],
  ['x-ima-cookie is required', ['account_headers_invalid', 'missing_cookie', 400]],
]);
const filesystem = new Map([['EACCES', 'permission_denied'], ['EPERM', 'permission_denied'],
  ['ENOENT', 'file_missing'], ['ENOSPC', 'disk_full'], ['EIO', 'io_failure'], ['EMFILE', 'file_limit']]);

function persistenceDiagnostic(error, { operation, phase } = {}) {
  const message = typeof error?.message === 'string' ? error.message : '';
  let code = /^[a-z_]+$/.test(error?.code || '') ? error.code : 'account_store_operation_failed';
  let statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
  let reason = code === 'account_store_operation_failed' ? 'unclassified' : 'coded_error';
  const known = classifications.get(message);
  if (code === 'account_store_operation_failed' && known) [code, reason, statusCode] = known;
  else if (code === 'account_store_operation_failed' && statusCode === 409
      && /^账号 [\s\S]+ 已存在；如确认要重新绑定登录态，请显式使用 replace$/.test(message)) {
    code = 'account_name_conflict'; reason = 'name_conflict';
  } else if (filesystem.has(error?.code)) reason = filesystem.get(error.code);
  else if (code === 'account_store_operation_failed' && error?.name === 'TypeError') reason = 'type_error';
  return { code, statusCode,
    // The caller supplies the operation label, never request data.
    operation: typeof operation === 'string' && /^[a-zA-Z]{1,48}$/.test(operation) ? operation : 'unknown',
    phase: phases.has(phase) ? phase : 'dispatch', reason };
}

module.exports = { persistenceDiagnostic };
