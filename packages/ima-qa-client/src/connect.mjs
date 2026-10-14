import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { atomic, defaultConfig, digest, fault, loadConfig, optionalJson, lock } from './config.mjs';
import { ImaClient } from './client.mjs';

// Local maintainer-only bridge from deployment to the ordinary Agent client.
// Never put an admin token, IMA cookie, encryption key or account in its output/config.
export async function connectLocal(options, { Client = ImaClient } = {}) {
  if (!options.providerEnv || !options.baseUrl) throw fault('local_connection_options_required');
  const url = new URL(options.baseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash
    || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/') throw fault('loopback_required');
  const input = resolve(options.providerEnv);
  const stat = await lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw fault('private_provider_file_required');
  let env;
  try { const text = await readFile(input, 'utf8'); env = text.trimStart().startsWith('{') ? JSON.parse(text) : parse(text); }
  catch { throw fault('invalid_private_provider_file'); }
  const scope = env.IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID || env.IMA_WEB_KNOWLEDGE_BASE_ID || env.IMA_SHARED_KNOWLEDGE_BASE_ID;
  if (typeof scope !== 'string' || !scope.trim()) throw fault('knowledge_scope_missing');
  let applications;
  try { applications = env.IMA_QA_APPLICATIONS_JSON ? JSON.parse(env.IMA_QA_APPLICATIONS_JSON) : []; }
  catch { throw fault('invalid_application_mapping'); }
  if (!Array.isArray(applications)) throw fault('invalid_application_mapping');
  const id = options.applicationId || (applications.length === 0 ? 'legacy' : applications.length === 1 ? applications[0].id : null);
  if (!id) throw fault('application_selection_required');
  const app = applications.find(x => x.id === id);
  if (id !== 'legacy' && !app) throw fault('application_not_found');
  const apiToken = app ? app.apiTokens?.[0] : env.IMA_QA_API_TOKEN;
  const internalServiceToken = app ? app.internalServiceTokens?.[0] : env.IMA_QA_INTERNAL_SERVICE_TOKEN;
  if (typeof apiToken !== 'string' || !apiToken || typeof internalServiceToken !== 'string' || !internalServiceToken) throw fault('credential_pair_missing');
  if (apiToken === internalServiceToken || [apiToken, internalServiceToken].includes(env.IMA_QA_ADMIN_TOKEN)) throw fault('credential_role_conflict');
  const file = resolve(options.config || defaultConfig()), profile = options.profile || 'default';
  return lock(`${file}.lock`, async () => {
    const root = await optionalJson(file) || { profiles: {} };
    const old = root.profiles?.[profile];
    const candidate = { baseUrl: url.origin, applicationId: id, clientId: old?.clientId || `ima-agent-${randomUUID()}`,
      knowledgeScopeRef: digest(scope.trim()), knowledgeBaseName: options.knowledgeBaseName || old?.knowledgeBaseName || '', apiToken, internalServiceToken };
    if (old) {
      const current = await loadConfig(file, profile);
      if (['baseUrl', 'applicationId', 'knowledgeScopeRef', 'apiToken', 'internalServiceToken'].some(key => current[key] !== candidate[key])) throw fault('existing_profile_protected');
      return { configured: true, reused: true, configFile: file, provider: await new Client(current).status() };
    }
    const provider = await new Client(candidate).status();
    if (!['verified', 'legacy_shared'].includes(provider.identityPairing)) throw fault('application_pairing_unverified');
    root.profiles ||= {};
    root.profiles[profile] = candidate;
    await atomic(file, root);
    return { configured: true, reused: false, configFile: file, provider };
  });
}
