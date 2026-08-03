#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3117';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_QUESTIONS = [
  '什么是3D高斯泼溅（3DGS）？',
  '使用无人机进行航拍采集时，如何规划飞行路径和重叠率？',
  '训练过程中显存不足，可以优先采取哪些优化措施？',
  'PostShot、BSD、LichtFeld Studio 在训练速度、显存和效果上有什么差异？',
  '大范围场景进行 3DGS 采集和训练时，应该如何分块处理？',
];

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    baseUrl: env.IMA_QA_CONCURRENCY_BASE_URL || DEFAULT_BASE_URL,
    concurrency: 2,
    followUp: false,
    mode: 'sse',
    out: '',
    question: [],
    questionsFile: '',
    requests: 0,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    token: env.IMA_QA_API_TOKEN || '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--follow-up') {
      args.followUp = true;
      continue;
    }
    const [rawKey, inlineValue] = argument.startsWith('--')
      ? argument.slice(2).split('=')
      : ['', ''];
    if (!rawKey) {
      throw new Error(`Unknown positional argument: ${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (inlineValue === undefined && value === undefined) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    switch (rawKey) {
      case 'base-url':
        args.baseUrl = value;
        break;
      case 'concurrency':
        args.concurrency = parsePositiveInteger(value, '--concurrency');
        break;
      case 'follow-up':
        args.followUp = parseBoolean(value, '--follow-up');
        break;
      case 'mode':
        if (!['sse', 'json'].includes(value)) {
          throw new Error('--mode must be sse or json');
        }
        args.mode = value;
        break;
      case 'out':
        args.out = value;
        break;
      case 'question':
        args.question.push(value);
        break;
      case 'questions':
        args.questionsFile = value;
        break;
      case 'requests':
        args.requests = parsePositiveInteger(value, '--requests');
        break;
      case 'timeout-ms':
        args.timeoutMs = parsePositiveInteger(value, '--timeout-ms');
        break;
      case 'token':
        args.token = value;
        break;
      default:
        throw new Error(`Unknown option: --${rawKey}`);
    }
  }

  args.baseUrl = String(args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  args.requests = args.requests || args.concurrency;
  return args;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

async function readQuestions(filePath) {
  if (!filePath) {
    return [];
  }
  const text = await fs.readFile(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        const parsed = JSON.parse(line);
        return String(parsed.question || '').trim();
      } catch {
        return line;
      }
    })
    .filter((question, index) => {
      if (!question) {
        throw new Error(`Empty question at ${filePath}:${index + 1}`);
      }
      return true;
    });
}

function buildQuestions(options, questionFileRows = []) {
  const pool = options.question.length
    ? options.question
    : questionFileRows.length
      ? questionFileRows
      : DEFAULT_QUESTIONS;
  return Array.from({ length: options.requests }, (_value, index) => pool[index % pool.length]);
}

async function runConcurrencyProbe(options, fetchImpl = globalThis.fetch) {
  if (!fetchImpl) {
    throw new Error('A fetch implementation is required');
  }

  const questionFileRows = await readQuestions(options.questionsFile);
  const questions = buildQuestions(options, questionFileRows);
  const runId = `${process.pid}-${Date.now()}`;
  const probes = questions.map((question, index) => ({
    clientId: `ima-concurrency-probe-${runId}-${index}`,
    marker: `CQA-${runId}-${index}`,
    question: `${question}（并发隔离测试标记 ${`CQA-${runId}-${index}`}，不要把标记当作知识内容。）`,
  }));
  const healthBefore = await readHealth(options, fetchImpl);
  const wallStartedAt = Date.now();
  const initial = await runInWaves(probes, options, fetchImpl, null);
  const followUp = options.followUp
    ? await runInWaves(
        initial.filter((result) => result.ok && result.conversationId).map((result) => ({
          ...result.probe,
          conversationId: result.conversationId,
          question: `请继续上一问，只补充一个最关键的注意事项，并保留会话上下文。追问标记 ${result.probe.marker}。`,
        })),
        options,
        fetchImpl,
        'follow-up',
      )
    : [];
  const healthAfter = await readHealth(options, fetchImpl);
  const report = buildReport({
    options,
    probes,
    initial,
    followUp,
    healthBefore,
    healthAfter,
    wallLatencyMs: Date.now() - wallStartedAt,
  });

  if (options.out) {
    await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await fs.writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

async function runInWaves(probes, options, fetchImpl, phase) {
  const results = [];
  for (let index = 0; index < probes.length; index += options.concurrency) {
    const wave = probes.slice(index, index + options.concurrency);
    const waveResults = await Promise.all(
      wave.map(async (probe) => {
        const result = await runProbe(probe, options, fetchImpl, phase);
        return { ...result, probe };
      }),
    );
    results.push(...waveResults);
  }
  return results;
}

async function runProbe(probe, options, fetchImpl, phase) {
  const startedMs = Date.now();
  try {
    const ask = await requestAsk(probe, options, fetchImpl);
    const detail = ask.conversationId
      ? await requestConversationDetail(probe, ask.conversationId, options, fetchImpl)
      : null;
    return {
      phase: phase || 'initial',
      ok: ask.ok && (!detail || detail.ok),
      status: ask.status,
      latencyMs: Date.now() - startedMs,
      conversationId: ask.conversationId,
      answer: ask.answer,
      sourceCount: ask.sources.length,
      searchSummary: ask.searchSummary,
      error: ask.error,
      failureReason: ask.failureReason,
      detailStatus: detail?.status || 0,
      historyMessageCount: detail?.messages?.length || 0,
      historyOwnQuestion: Boolean(detail?.messages?.some((message) => message.content === probe.question)),
      crossContextMarkers: findForeignMarkers(detail, probe.marker),
    };
  } catch (error) {
    return {
      phase: phase || 'initial',
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedMs,
      conversationId: '',
      answer: '',
      sourceCount: 0,
      searchSummary: '',
      error: error.message,
      failureReason: error.name === 'AbortError' ? 'timeout' : 'network_failure',
      detailStatus: 0,
      historyMessageCount: 0,
      historyOwnQuestion: false,
      crossContextMarkers: [],
    };
  }
}

async function requestAsk(probe, options, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(`${options.baseUrl}/api/ask`, {
      method: 'POST',
      headers: {
        Accept: options.mode === 'sse' ? 'text/event-stream' : 'application/json',
        'Content-Type': 'application/json',
        'X-IMA-Client-Id': probe.clientId,
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({
        question: probe.question,
        ...(probe.conversationId ? { conversationId: probe.conversationId } : {}),
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = options.mode === 'sse' ? parseSseResponse(text) : parseJsonResponse(text);
    return {
      ok: response.ok && !parsed.error,
      status: response.status,
      conversationId: parsed.conversationId,
      answer: parsed.answer,
      sources: parsed.sources,
      searchSummary: parsed.searchSummary,
      error: parsed.error || (!response.ok ? `HTTP ${response.status}` : ''),
      failureReason: parsed.failureReason || (!response.ok ? 'http_error' : ''),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestConversationDetail(probe, conversationId, options, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(
      `${options.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`,
      {
        headers: {
          'X-IMA-Client-Id': probe.clientId,
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        signal: controller.signal,
      },
    );
    const parsed = await response.json().catch(() => ({}));
    return {
      ok: response.ok && parsed.success !== false,
      status: response.status,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      error: parsed.error || '',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readHealth(options, fetchImpl) {
  try {
    const response = await fetchImpl(`${options.baseUrl}/healthz`);
    return response.json();
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function parseJsonResponse(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return {
      conversationId: parsed.conversationId || '',
      answer: parsed.answer || '',
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      searchSummary: parsed.searchSummary || '',
      error: parsed.success === false ? parsed.error || '请求失败' : '',
      failureReason: parsed.failureReason || '',
    };
  } catch {
    return { conversationId: '', answer: '', sources: [], searchSummary: '', error: '响应不是有效 JSON' };
  }
}

function parseSseResponse(text) {
  const parsed = { conversationId: '', answer: '', sources: [], searchSummary: '', error: '', failureReason: '' };
  for (const block of String(text || '').split(/\r?\n\r?\n/)) {
    const event = parseSseBlock(block);
    if (!event) {
      continue;
    }
    if (event.event === 'conversation' || event.event === 'done') {
      parsed.conversationId = event.data.conversationId || parsed.conversationId;
    }
    if (event.event === 'sources') {
      parsed.sources = Array.isArray(event.data.sources) ? event.data.sources : parsed.sources;
      parsed.searchSummary = event.data.searchSummary || parsed.searchSummary;
    }
    if (event.event === 'delta') {
      parsed.answer += event.data.text || '';
    }
    if (event.event === 'error') {
      parsed.error = event.data.error || '请求失败';
      parsed.failureReason = event.data.failureReason || '';
    }
  }
  return parsed;
}

function parseSseBlock(block) {
  const lines = String(block || '').split(/\r?\n/);
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
  const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
  if (!event || !data) {
    return null;
  }
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

function findForeignMarkers(detail, ownMarker) {
  if (!detail?.messages?.length) {
    return [];
  }
  const text = JSON.stringify(detail.messages);
  return [...text.matchAll(/CQA-[0-9]+-[0-9]+-[0-9]+/g)]
    .map((match) => match[0])
    .filter((marker, index, markers) => marker !== ownMarker && markers.indexOf(marker) === index);
}

function buildReport({ options, probes, initial, followUp, healthBefore, healthAfter, wallLatencyMs }) {
  const allResults = [...initial, ...followUp];
  const successfulInitial = initial.filter((result) => result.ok).length;
  const successfulFollowUp = followUp.filter((result) => result.ok).length;
  const uniqueConversations = new Set(initial.map((result) => result.conversationId).filter(Boolean));
  const crossContextResults = allResults.filter((result) => result.crossContextMarkers.length > 0);
  return {
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    mode: options.mode,
    requested: probes.length,
    concurrency: options.concurrency,
    followUpEnabled: options.followUp,
    wallLatencyMs,
    initial: {
      total: initial.length,
      ok: successfulInitial,
      failed: initial.length - successfulInitial,
      uniqueConversationCount: uniqueConversations.size,
    },
    followUp: {
      total: followUp.length,
      ok: successfulFollowUp,
      failed: followUp.length - successfulFollowUp,
    },
    isolation: {
      uniqueConversationCountMatchesRequestCount: uniqueConversations.size === successfulInitial,
      crossContextSuspected: crossContextResults.length > 0,
      crossContextResultCount: crossContextResults.length,
      historyOwnershipChecked: allResults.filter((result) => result.detailStatus > 0).length,
    },
    healthBefore,
    healthAfter,
    results: allResults.map((result) => ({
      ...result,
      probe: {
        clientId: result.probe.clientId,
        marker: result.probe.marker,
        question: result.probe.question,
      },
    })),
  };
}

function formatReport(report) {
  const lines = [
    'IMA QA 并发与多会话隔离测试',
    `地址：${report.baseUrl}`,
    `模式：${report.mode}，并发：${report.concurrency}，请求数：${report.requested}，追问：${report.followUpEnabled ? '是' : '否'}`,
    `首轮：${report.initial.ok}/${report.initial.total} 成功，唯一会话 ${report.initial.uniqueConversationCount}`,
    `追问：${report.followUp.ok}/${report.followUp.total} 成功`,
    `上下文串线疑点：${report.isolation.crossContextSuspected ? '有，请查看 JSON 结果' : '未发现'}`,
    `总墙钟耗时：${report.wallLatencyMs} ms`,
    `结束健康状态：active=${report.healthAfter?.queue?.activeRequests ?? '-'}，queued=${report.healthAfter?.queue?.queuedRequests ?? '-'}`,
    '',
    ...report.results.map((result, index) =>
      `${index + 1}. ${result.phase} status=${result.status} ok=${result.ok ? 'yes' : 'no'} latency=${result.latencyMs}ms conversation=${result.conversationId || '-'} history=${result.historyMessageCount} sources=${result.sourceCount}${result.error ? ` error=${result.error}` : ''}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

const isNodeTest = process.execArgv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (!isNodeTest && isMainModule) {
  try {
    const options = parseArgs();
    const report = await runConcurrencyProbe(options);
    process.stdout.write(formatReport(report));
    if (options.out) {
      process.stdout.write(`JSON 报告：${path.resolve(options.out)}\n`);
    }
    if (!report.initial.ok || report.isolation.crossContextSuspected) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`并发测试失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

export {
  DEFAULT_QUESTIONS,
  buildQuestions,
  buildReport,
  formatReport,
  parseArgs,
  parseSseResponse,
  runConcurrencyProbe,
};
