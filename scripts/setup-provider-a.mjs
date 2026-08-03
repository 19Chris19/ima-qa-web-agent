#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import providerAReleaseModule from '../src/provider-a-release.js';

const { buildProviderAEnv } = providerAReleaseModule;
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = path.resolve(appDir, args.env || '.env');
  if (fs.existsSync(envPath) && !args.force) {
    throw new Error(`${envPath} 已存在。确认覆盖后使用 --force。`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const sharedKnowledgeBaseId = cleanRequired(
      args.kb || args.knowledgeBaseId || (await rl.question('IMA Web 共享知识库数字 ID: ')),
      '共享知识库 ID',
    );
    const allowedOrigins = cleanSingleLine(
      args.allowedOrigins ?? (await rl.question('允许嵌入或直调的网页域名，多个用逗号分隔（可直接回车）: ')),
    );
    const content = buildProviderAEnv({
      sharedKnowledgeBaseId,
      allowedOrigins,
      port: args.port || '3000',
      hostPort: args.hostPort || '3117',
    });
    fs.mkdirSync(path.join(appDir, 'runtime'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(envPath, content, { mode: 0o600 });
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      // The create mode is the primary protection on platforms without chmod.
    }

    console.log(`\n已创建私有配置：${envPath}`);
    console.log('下一步：');
    console.log('1. 启动服务：docker compose up -d --build，或 npm start。');
    console.log('2. 接入首个账号：npm run admin:enroll -- --name account-a --server-url http://127.0.0.1:3117');
    console.log('扫码完成后，浏览器会自动关闭；凭证只会写入 runtime/ 私有目录。');
  } finally {
    rl.close();
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
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
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

function cleanRequired(value, name) {
  const text = cleanSingleLine(value);
  if (!text) {
    throw new Error(`${name}不能为空`);
  }
  return text;
}

function cleanSingleLine(value) {
  return String(value || '').replace(/[\r\n]+/g, '').trim();
}

main().catch((error) => {
  console.error(`Provider A 初始化失败：${error.message}`);
  process.exit(1);
});
