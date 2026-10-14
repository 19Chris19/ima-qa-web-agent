const { spawnSync } = require('node:child_process');
const path = require('node:path');

function conflict(code = 'account_store_generation_conflict') {
  return Object.assign(new Error(code === 'account_store_locked' ? '账号库正在更新，请稍后重试' : '账号状态已变化，请刷新后重试'), { code, statusCode: 409 });
}

function commitStore(file, value) {
  const worker = path.join(__dirname, 'store-commit-worker.js');
  const result = spawnSync(process.execPath, [worker], {
    input: JSON.stringify({ file, value }),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20000,
    windowsHide: true,
  });
  if (result.error) throw Object.assign(new Error('账号库写入未完成'), { code: 'account_store_commit_failed', statusCode: 503 });
  let response;
  try { response = JSON.parse(result.stdout || '{}'); } catch {}
  if (result.status !== 0 || !response?.ok) {
    const code = ['account_store_generation_conflict', 'account_store_locked'].includes(response?.code)
      ? response.code : 'account_store_commit_failed';
    throw Object.assign(new Error(code === 'account_store_generation_conflict' ? '账号状态已变化，请刷新后重试' : '账号库写入未完成'), {
      code,
      statusCode: code === 'account_store_generation_conflict' || code === 'account_store_locked' ? 409 : 503,
    });
  }
  return { ...value, generation: response.generation };
}

module.exports = { commitStore, conflict };
