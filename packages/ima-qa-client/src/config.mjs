import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

export const defaultConfig = () => process.env.IMA_QA_CONFIG || join(homedir(), '.config/ima-qa/client.json');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function fault(code, detail = {}) { return Object.assign(new Error(code), { code, ...detail }); }
export async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export async function optionalJson(path) {
  try { return await json(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function lock(path, action) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw fault('operation_locked', { recovery: 'Another operation is active. If its process exited, remove the indicated lock directory.', lockPath: path });
    throw error;
  }
  try { return await action(); } finally { await rm(path, { recursive: true, force: true }); }
}
export async function loadConfig(path = defaultConfig(), profile = 'default') {
  const file = resolve(path);
  const root = await json(file);
  const selected = root.profiles?.[profile];
  if (!selected) throw fault('profile_not_found');
  const p = { ...selected };
  const url = new URL(p.baseUrl);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw fault('invalid_provider_url');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw fault('https_required');
  if (!p.applicationId || !p.clientId || !/^[a-f0-9]{64}$/.test(p.knowledgeScopeRef || '')) throw fault('invalid_profile');
  for (const key of ['apiToken', 'internalServiceToken']) {
    p[key] = p[`${key}Env`] ? process.env[p[`${key}Env`]] : p[key];
    if (typeof p[key] !== 'string' || !p[key]) throw fault('credential_missing', { credential: key });
  }
  p.baseUrl = url.href.replace(/\/$/, '');
  p.profile = profile;
  p.stateDir = resolve(dirname(file), root.stateDir || 'state', digest(`${p.baseUrl}\n${p.applicationId}\n${p.clientId}\n${p.knowledgeScopeRef}`));
  return p;
}
