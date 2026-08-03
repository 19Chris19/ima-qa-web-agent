#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { chromium } from 'playwright-core';
import accountDirectoryModule from '../src/web-agent-account-directory.js';
import imaWebAgentModule from '../src/ima-web-agent-client.js';

const { WebAgentAccountDirectory, defaultAccountStoreKeyPath, defaultAccountStorePath } =
  accountDirectoryModule;
const { IMAWebAgentClient, getBkn, stringifyCookie } = imaWebAgentModule;

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(appDir, '.env') });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let context;
  let userDataDir = '';
  let captured = false;

  try {
    const name = cleanAccountName(args.name || (await rl.question('账号名称，如 account-a: ')));
    const knowledgeBaseId = cleanRequired(
      args.kb ||
        args.knowledgeBaseId ||
        process.env.IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID ||
        process.env.IMA_WEB_KNOWLEDGE_BASE_ID ||
        (await rl.question('IMA Web 共享知识库 ID: ')),
      'knowledgeBaseId',
    );
    const serverUrl = String(args.serverUrl || process.env.IMA_QA_ADMIN_URL || '')
      .trim()
      .replace(/\/+$/, '');
    const browserPath = resolveBrowserPath(args.browser || process.env.IMA_WEB_AGENT_BROWSER_PATH);
    const storePath = path.resolve(
      args.store || process.env.IMA_WEB_AGENT_ACCOUNT_STORE_PATH || defaultAccountStorePath(),
    );
    const keyPath = path.resolve(
      args.keyPath || process.env.IMA_WEB_AGENT_ACCOUNT_STORE_KEY_PATH || defaultAccountStoreKeyPath(),
    );
    if (serverUrl && args.runtimeEnv) {
      throw new Error('--runtime-env 只能用于直接写本地账号库；远程接入由服务端加密账号库保存凭证');
    }
    const runtimeEnvPath = args.runtimeEnv ? path.resolve(args.runtimeEnv) : '';
    userDataDir =
      args.userDataDir || path.join(path.dirname(storePath), 'browser-profiles', `ima-${name}`);
    if (args.resetProfile) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    const store = serverUrl ? null : new WebAgentAccountDirectory({ storePath, keyPath });

    if (serverUrl) {
      await preflightServerEnrollment({
        serverUrl,
        adminToken: process.env.IMA_QA_ADMIN_TOKEN,
        name,
        knowledgeBaseId,
        replace: Boolean(args.replace),
      });
    } else if (!args.replace) {
      const existing = store.listAccounts().find((account) =>
        normalizeAccountKey(account.id) === normalizeAccountKey(name) ||
        normalizeAccountKey(account.name) === normalizeAccountKey(name),
      );
      if (existing) {
        throw new Error(`账号 ${existing.name} 已存在；如确认要重新绑定登录态，请显式使用 --replace`);
      }
    }

    console.log(`\n接入预检通过。将打开浏览器，请扫码/登录 IMA，并确认账号已加入共享知识库 ${knowledgeBaseId}。`);
    console.log(`浏览器: ${browserPath}`);
    console.log(`保存位置: ${serverUrl ? `服务端 ${serverUrl}` : store.storePath}`);
    console.log('登录完成后脚本会自动捕获登录态，不会输出 token 原文。\n');

    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: browserPath,
      headless: false,
      viewport: { width: 1280, height: 860 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(
      `https://ima.qq.com/wikis?knowledgeBaseId=${encodeURIComponent(
        knowledgeBaseId,
      )}&isUseKnowledgeBaseQa=1`,
      { waitUntil: 'domcontentloaded' },
    );

    const auth = await waitForLoginAuth(context, Number(args.timeoutMs || 10 * 60 * 1000));
    const headers = auth.headers;

    const client = new IMAWebAgentClient({
      id: name,
      name,
      knowledgeBaseId,
      headers,
      modelId: args.modelId || process.env.IMA_WEB_AGENT_MODEL_ID || 'official_3',
      modelType: Number(args.modelType || process.env.IMA_WEB_AGENT_MODEL_TYPE || 3),
      runtimeEnvPath,
    });
    await client.initSession();

    const accountInput = {
      id: args.id || name,
      name,
      knowledgeBaseId,
      headers,
      runtimeEnvPath,
      modelId: args.modelId || process.env.IMA_WEB_AGENT_MODEL_ID || 'official_3',
      modelType: Number(args.modelType || process.env.IMA_WEB_AGENT_MODEL_TYPE || 3),
      tokenExpiresAt: auth.tokenExpiresAt,
      refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
      source: 'browser-onboarding',
    };
    const account = serverUrl
      ? await syncAccountToServer(serverUrl, process.env.IMA_QA_ADMIN_TOKEN, {
        ...accountInput,
        replace: Boolean(args.replace),
      })
      : store.upsertCapturedAccount({ ...accountInput, replace: Boolean(args.replace) });
    captured = true;
    console.log('\n账号接入成功：');
    console.log(JSON.stringify({
      id: account.id,
      name: account.name,
      status: account.status,
      runtimeEnvPath: account.runtimeEnvPath,
      tokenExpiresAt: account.tokenExpiresAt,
      refreshTokenExpiresAt: account.refreshTokenExpiresAt,
    }, null, 2));
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (captured && userDataDir && !args.keepProfile) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    rl.close();
  }
}

async function syncAccountToServer(serverUrl, adminToken, account) {
  const headers = { 'content-type': 'application/json' };
  if (adminToken) {
    headers.authorization = `Bearer ${adminToken}`;
  }
  const response = await fetch(`${serverUrl}/api/admin/accounts`, {
    method: 'POST',
    headers,
    body: JSON.stringify(account),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `无法同步到问答服务（HTTP ${response.status}）`);
  }
  return payload.account;
}

async function preflightServerEnrollment({ serverUrl, adminToken, name, knowledgeBaseId, replace }) {
  const headers = {};
  if (adminToken) {
    headers.authorization = `Bearer ${adminToken}`;
  }
  const [bootstrap, accountList] = await Promise.all([
    getServerJson(`${serverUrl}/api/admin/bootstrap`, headers),
    getServerJson(`${serverUrl}/api/admin/accounts`, headers),
  ]);
  if (bootstrap.provider !== 'ima-web-agent') {
    throw new Error('目标服务不是 Provider A（IMA Web Agent）');
  }
  const configuredKnowledgeBaseId = String(bootstrap.sharedKnowledgeBaseId || '').trim();
  if (configuredKnowledgeBaseId && configuredKnowledgeBaseId !== knowledgeBaseId) {
    throw new Error('目标服务配置的共享知识库与本次接入不一致');
  }
  const normalizedName = normalizeAccountKey(name);
  const existing = (accountList.accounts || []).find((account) =>
    normalizeAccountKey(account.id) === normalizedName || normalizeAccountKey(account.name) === normalizedName,
  );
  if (existing && !replace) {
    throw new Error(`账号 ${existing.name} 已存在；如确认要重新绑定登录态，请显式使用 --replace`);
  }
}

async function getServerJson(url, headers) {
  const response = await fetch(url, { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `无法连接或验证目标服务（HTTP ${response.status}）`);
  }
  return payload;
}

async function waitForLoginAuth(context, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const cookies = await context.cookies('https://ima.qq.com');
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
      const accountInfo = await readLocalStorageAccountInfo(page);
      if (accountInfo?.token && accountInfo.refreshToken && (accountInfo.userId || accountInfo.uid)) {
        const cookieValues = {
          'IMA-UID': accountInfo.userId || accountInfo.uid,
          'IMA-TOKEN': accountInfo.token,
          'IMA-REFRESH-TOKEN': accountInfo.refreshToken,
          'TOKEN-TYPE': String(accountInfo.tokenType || 0),
          'UID-TYPE': String(accountInfo.idType || '1'),
        };
        return {
          headers: {
            'x-ima-cookie': stringifyCookie(cookieValues),
            'x-ima-bkn': String(getBkn(accountInfo.token)),
          },
          tokenExpiresAt: positiveNumber(accountInfo.tokenExpiredTime),
          refreshTokenExpiresAt: positiveNumber(accountInfo.refreshTokenExpiredTime),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('等待 IMA 登录超时，未捕获到完整 IMA 登录态');
}

async function readLocalStorageAccountInfo(page) {
  try {
    return await page.evaluate(() => {
      const raw = window.localStorage.getItem('ima-universal-local-storage-accountInfo');
      if (!raw) {
        return null;
      }
      return JSON.parse(raw);
    });
  } catch {
    return null;
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      continue;
    }
    const [rawKey, inlineValue] = value.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      result[key] = inlineValue;
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function resolveBrowserPath(candidate) {
  const candidates = [
    candidate,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/ego lite.app/Contents/MacOS/ego lite',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  const found = candidates.find((value) => fs.existsSync(value));
  if (!found) {
    throw new Error('未找到可用浏览器，请通过 --browser 或 IMA_WEB_AGENT_BROWSER_PATH 指定 Chrome/Ego 路径');
  }
  return found;
}

function parseCookie(cookieHeader) {
  const parsed = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const [key, ...rawValue] = part.trim().split('=');
    if (key) {
      parsed[key] = rawValue.join('=');
    }
  }
  return parsed;
}

function cookieExpiryMs(cookies, name) {
  const cookie = cookies.find((item) => item.name === name);
  return cookie?.expires && cookie.expires > 0 ? Math.trunc(cookie.expires * 1000) : null;
}

function positiveNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function cleanRequired(value, name) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`${name} is required`);
  }
  return text;
}

function cleanAccountName(value) {
  return cleanRequired(value, 'name').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80);
}

function normalizeAccountKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

main().catch((error) => {
  console.error(`账号接入失败：${error.message}`);
  process.exit(1);
});
