#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_QUESTIONS_PATH = path.join(__dirname, 'questions.jsonl');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const OPENAPI_QUOTA_EXCEEDED_REASON = 'openapi_quota_exceeded';
const OPENAPI_QUOTA_EXCEEDED_PATTERN = /openapi_quota_exceeded|请求超量|明日再试|200005/i;

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    baseUrl: env.IMA_QA_EVAL_BASE_URL || DEFAULT_BASE_URL,
    category: '',
    concurrency: 1,
    delayMs: 0,
    difficulty: '',
    dryRun: false,
    limit: 0,
    fromResults: '',
    onlyFailed: false,
    out: '',
    provider: env.IMA_QA_EVAL_PROVIDER || 'openapi-mimo',
    questions: DEFAULT_QUESTIONS_PATH,
    report: '',
    resume: false,
    timeoutMs: 180000,
    token: env.IMA_QA_API_TOKEN || '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--resume') {
      args.resume = true;
      continue;
    }
    if (arg === '--only-failed') {
      args.onlyFailed = true;
      continue;
    }

    const [rawKey, inlineValue] = arg.startsWith('--') ? arg.slice(2).split('=') : ['', ''];
    if (!rawKey) {
      throw new Error(`Unknown positional argument: ${arg}`);
    }

    const value = inlineValue ?? argv[++index];
    if (inlineValue === undefined && value === undefined) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    switch (rawKey) {
      case 'base-url':
        args.baseUrl = value;
        break;
      case 'category':
        args.category = value;
        break;
      case 'concurrency':
        args.concurrency = parsePositiveInteger(value, '--concurrency');
        break;
      case 'delay-ms':
        args.delayMs = parseNonNegativeInteger(value, '--delay-ms');
        break;
      case 'difficulty':
        args.difficulty = value;
        break;
      case 'from-results':
        args.fromResults = value;
        break;
      case 'limit':
        args.limit = parseNonNegativeInteger(value, '--limit');
        break;
      case 'out':
        args.out = value;
        break;
      case 'provider':
        args.provider = value;
        break;
      case 'questions':
        args.questions = value;
        break;
      case 'report':
        args.report = value;
        break;
      case 'resume':
        args.resume = parseBooleanFlag(value, '--resume');
        break;
      case 'only-failed':
        args.onlyFailed = parseBooleanFlag(value, '--only-failed');
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
  return args;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseBooleanFlag(value, name) {
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
  const text = await fs.readFile(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

async function readResults(filePath) {
  if (!filePath) {
    return [];
  }

  let text = '';
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid result JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function selectQuestions(questions, options = {}) {
  let selected = [...questions];
  if (options.category) {
    selected = selected.filter((question) => question.category === options.category);
  }
  if (options.difficulty) {
    selected = selected.filter((question) => question.difficulty === options.difficulty);
  }
  const previousResults = Array.isArray(options.previousResults) ? options.previousResults : [];
  if (options.onlyFailed) {
    const failedIds = new Set(
      previousResults.filter((result) => result?.id && !result.ok).map((result) => result.id),
    );
    selected = selected.filter((question) => failedIds.has(question.id));
  }
  if (options.resume) {
    const completedIds = new Set(
      previousResults.filter((result) => result?.id && result.ok).map((result) => result.id),
    );
    selected = selected.filter((question) => !completedIds.has(question.id));
  }
  if (options.limit > 0) {
    selected = selected.slice(0, options.limit);
  }
  return selected;
}

async function runEvaluation(options, fetchImpl = globalThis.fetch) {
  if (!fetchImpl) {
    throw new Error('A fetch implementation is required');
  }

  const outputPath = options.out || defaultResultPath(options.provider);
  const reportPath = options.report || outputPath.replace(/\.jsonl$/i, '.md');
  const previousResultsPath = options.fromResults || outputPath;
  const previousResults =
    options.resume || options.onlyFailed ? await readResults(previousResultsPath) : [];

  if (options.onlyFailed && previousResults.length === 0) {
    throw new Error('--only-failed requires --from-results or an existing --out JSONL file');
  }

  const questions = selectQuestions(await readQuestions(options.questions), {
    ...options,
    previousResults,
  });

  if (options.dryRun) {
    return {
      dryRun: true,
      options,
      questions,
      outputPath,
      reportPath,
      previousResultsPath,
      summary: summarizeResults([]),
    };
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });

  const results = [];
  let nextIndex = 0;
  const stopState = {
    stoppedEarly: false,
    stopReason: '',
  };

  async function worker() {
    while (!stopState.stoppedEarly && nextIndex < questions.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const result = await runQuestion(questions[currentIndex], options, fetchImpl);
      results[currentIndex] = result;
      await fs.appendFile(outputPath, `${JSON.stringify(result)}\n`);
      if (isQuotaExceededResult(result)) {
        stopState.stoppedEarly = true;
        stopState.stopReason = OPENAPI_QUOTA_EXCEEDED_REASON;
      }
      if (!stopState.stoppedEarly && options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }
  }

  const workerCount = Math.min(options.concurrency || 1, questions.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const completedResults = results.filter(Boolean);
  const summary = summarizeResults(completedResults, stopState);
  await fs.writeFile(
    reportPath,
    renderEvaluationReport({ options, questions, results: completedResults, summary }),
    'utf8',
  );

  return {
    dryRun: false,
    options,
    questions,
    results: completedResults,
    outputPath,
    reportPath,
    previousResultsPath,
    summary,
  };
}

async function runQuestion(question, options, fetchImpl) {
  const startedAt = new Date();
  const startedMs = Date.now();
  let timeout = null;

  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const response = await fetchImpl(`${options.baseUrl}/api/ask`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-IMA-QA-Eval': '1',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({ question: question.question }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    timeout = null;

    const text = await response.text();
    const parsed = safeJson(text);
    const endedAt = new Date();
    const sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
    const diagnostics = parsed?.diagnostics || null;
    const ok = response.ok && parsed?.success !== false;
    const failureReason = classifyResponseFailure({
      ok,
      response,
      parsed,
      text,
      sources,
    });
    return {
      id: question.id,
      suite: question.suite,
      category: question.category,
      difficulty: question.difficulty,
      provider: options.provider,
      question: question.question,
      ok,
      status: response.status,
      latencyMs: Date.now() - startedMs,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      answer: parsed?.answer || '',
      sources,
      diagnostics,
      queryVariantCount: getQueryVariantCount(diagnostics),
      retrievedSourceCount: sources.length,
      enrichedSourceCount: getEnrichedSourceCount(diagnostics),
      requestId: parsed?.requestId || '',
      failureReason,
      error: parsed?.error || (!response.ok ? `HTTP ${response.status}` : ''),
    };
  } catch (error) {
    const failureReason = classifyThrownFailure(error);
    return {
      id: question.id,
      suite: question.suite,
      category: question.category,
      difficulty: question.difficulty,
      provider: options.provider,
      question: question.question,
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedMs,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      answer: '',
      sources: [],
      diagnostics: null,
      queryVariantCount: 0,
      retrievedSourceCount: 0,
      enrichedSourceCount: 0,
      requestId: '',
      failureReason,
      error: error.name === 'AbortError' ? 'Request timed out' : error.message,
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function classifyResponseFailure({ ok, response, parsed, text, sources }) {
  const combined = `${parsed?.failureReason || ''} ${parsed?.error || ''} ${parsed?.code || ''} ${text || ''}`;
  if (OPENAPI_QUOTA_EXCEEDED_PATTERN.test(combined)) {
    return OPENAPI_QUOTA_EXCEEDED_REASON;
  }
  if (ok && sources.length === 0) {
    return 'no_evidence';
  }
  if (ok) {
    return '';
  }
  if (/mimo|生成|模型/i.test(combined)) {
    return 'mimo_failure';
  }
  if (response.status === 408 || response.status === 504 || /timeout|timed out|超时/i.test(combined)) {
    return 'timeout';
  }
  if (!response.ok) {
    return 'http_error';
  }
  return 'unknown';
}

function classifyThrownFailure(error) {
  const message = `${error?.name || ''} ${error?.message || ''}`;
  if (OPENAPI_QUOTA_EXCEEDED_PATTERN.test(message)) {
    return OPENAPI_QUOTA_EXCEEDED_REASON;
  }
  if (error?.name === 'AbortError' || /timeout|timed out|超时/i.test(message)) {
    return 'timeout';
  }
  return 'network_failure';
}

function getQueryVariantCount(diagnostics) {
  if (Number.isFinite(diagnostics?.queryVariantCount)) {
    return diagnostics.queryVariantCount;
  }
  return Array.isArray(diagnostics?.matchedQueries) ? diagnostics.matchedQueries.length : 0;
}

function getEnrichedSourceCount(diagnostics) {
  return Number.isFinite(diagnostics?.enrichedSourceCount) ? diagnostics.enrichedSourceCount : 0;
}

function isQuotaExceededResult(result) {
  if (!result) {
    return false;
  }
  return (
    result.failureReason === OPENAPI_QUOTA_EXCEEDED_REASON ||
    OPENAPI_QUOTA_EXCEEDED_PATTERN.test(`${result.error || ''} ${result.status || ''}`)
  );
}

function summarizeResults(results, stopState = {}) {
  const rows = results.filter(Boolean);
  const total = rows.length;
  const ok = rows.filter((result) => result.ok).length;
  const failed = total - ok;
  const latencies = rows.filter((result) => result.latencyMs >= 0).map((result) => result.latencyMs);
  const sourceCounts = rows.map((result) => result.sources?.length || 0);

  return {
    total,
    ok,
    failed,
    stoppedEarly: Boolean(stopState.stoppedEarly),
    stopReason: stopState.stopReason || '',
    successRate: total ? ok / total : 0,
    avgLatencyMs: average(latencies),
    avgSourceCount: average(sourceCounts),
    avgQueryVariantCount: average(rows.map((result) => result.queryVariantCount || 0)),
    avgEnrichedSourceCount: average(rows.map((result) => result.enrichedSourceCount || 0)),
    failureReasons: countBy(rows, 'failureReason'),
    byCategory: groupSummary(rows, 'category'),
    byDifficulty: groupSummary(rows, 'difficulty'),
  };
}

function groupSummary(results, key) {
  const grouped = new Map();
  for (const result of results) {
    const group = result[key] || 'unknown';
    if (!grouped.has(group)) {
      grouped.set(group, []);
    }
    grouped.get(group).push(result);
  }

  return Object.fromEntries(
    [...grouped.entries()].map(([group, items]) => [
      group,
      {
        total: items.length,
        ok: items.filter((item) => item.ok).length,
        avgLatencyMs: average(items.map((item) => item.latencyMs)),
        avgSourceCount: average(items.map((item) => item.sources?.length || 0)),
        avgQueryVariantCount: average(items.map((item) => item.queryVariantCount || 0)),
        avgEnrichedSourceCount: average(items.map((item) => item.enrichedSourceCount || 0)),
      },
    ]),
  );
}

function countBy(results, key) {
  const counts = {};
  for (const result of results) {
    const value = result[key] || '';
    if (!value) {
      continue;
    }
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function average(values) {
  const validValues = values.filter((value) => Number.isFinite(value));
  if (!validValues.length) {
    return 0;
  }
  return Math.round(validValues.reduce((sum, value) => sum + value, 0) / validValues.length);
}

function renderReport({ options, questions, results, summary }) {
  const generatedAt = new Date().toISOString();
  const lines = [
    `# IMA QA Evaluation Report`,
    '',
    `- Generated at: ${generatedAt}`,
    `- Provider label: ${options.provider}`,
    `- Base URL: ${options.baseUrl}`,
    `- Questions: ${questions.length}`,
    `- Output JSONL: ${options.out || '(default)'}`,
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Total | ${summary.total} |`,
    `| Success | ${summary.ok} |`,
    `| Failed | ${summary.failed} |`,
    `| Stopped early | ${summary.stoppedEarly ? 'yes' : 'no'} |`,
    `| Stop reason | ${summary.stopReason || ''} |`,
    `| Success rate | ${(summary.successRate * 100).toFixed(1)}% |`,
    `| Avg latency | ${summary.avgLatencyMs} ms |`,
    `| Avg source count | ${summary.avgSourceCount} |`,
    `| Avg query variants | ${summary.avgQueryVariantCount} |`,
    `| Avg enriched sources | ${summary.avgEnrichedSourceCount} |`,
    '',
    '## Failure Reasons',
    '',
    renderFailureReasonTable(summary.failureReasons),
    '',
    '## By Category',
    '',
    renderGroupTable(summary.byCategory),
    '',
    '## By Difficulty',
    '',
    renderGroupTable(summary.byDifficulty),
    '',
    '## Manual Scoring Sheet',
    '',
    '| ID | Category | Difficulty | OK | Sources | Query variants | Enriched | Failure reason | Activeness | Correctness | Citation | Coverage | Boundary | Notes |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((result) =>
      `| ${result.id} | ${result.category} | ${result.difficulty} | ${result.ok ? 'yes' : 'no'} | ${result.sources?.length || 0} | ${result.queryVariantCount || 0} | ${result.enrichedSourceCount || 0} | ${escapeTable(result.failureReason || '')} |  |  |  |  |  | ${escapeTable(result.error || '')} |`,
    ),
    '',
    '## Failed Requests',
    '',
    ...renderFailures(results),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function renderEvaluationReport(context) {
  if (String(context.options?.provider || '').includes('local-rag')) {
    return renderLocalRagChineseReport(context);
  }
  return renderReport(context);
}

function renderLocalRagChineseReport({ options, questions, results, summary }) {
  const generatedAt = new Date().toISOString();
  const lines = [
    '# Provider C 本地知识调度评测报告',
    '',
    `- 生成时间：${generatedAt}`,
    `- Provider：${options.provider}`,
    `- Base URL：${options.baseUrl}`,
    `- 本次题数：${questions.length}`,
    `- 成功：${summary.ok}/${summary.total}`,
    `- 平均耗时：${summary.avgLatencyMs} ms`,
    `- 平均来源数：${summary.avgSourceCount}`,
    `- 平均 query 数：${summary.avgQueryVariantCount}`,
    '',
    '## 复核说明',
    '',
    '每题按“一问一答 + 调度诊断 + 人工评分位”展示。人工复核重点看：是否积极调动资料、是否覆盖不同群/日期、引用是否可靠、是否过度拒答。',
    '',
    ...results.flatMap((result, index) => renderLocalRagQuestionReview(result, index + 1)),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function renderLocalRagQuestionReview(result, ordinal) {
  const diagnostics = result.diagnostics || {};
  const coverage = diagnostics.coverage || {};
  const sourceTitles = (result.sources || [])
    .slice(0, 10)
    .map((source, index) => `${index + 1}. ${source.title || '未命名资料'}`)
    .join('\n');
  const answer = result.answer ? truncateReportText(result.answer, 1200) : result.error || '无回答';
  return [
    `## ${ordinal}. ${result.id}（${result.category} / ${result.difficulty}）`,
    '',
    `**问题**：${result.question}`,
    '',
    `**回答摘录**：${escapeMarkdown(answer)}`,
    '',
    '**调度诊断**：',
    '',
    `- planner：${diagnostics.plannerType || 'unknown'}`,
    `- query 数：${result.queryVariantCount || diagnostics.queryVariantCount || 0}`,
    `- 首轮候选：${diagnostics.firstPassCandidateCount ?? ''}`,
    `- 二次检索词：${Array.isArray(diagnostics.secondPassTerms) ? diagnostics.secondPassTerms.join('、') : ''}`,
    `- 二次候选：${diagnostics.secondPassCandidateCount ?? ''}`,
    `- 去重候选：${diagnostics.dedupedCandidateCount ?? ''}`,
    `- 去歧义排除：${diagnostics.discardedByDisambiguation ?? ''}`,
    `- 证据候选：${diagnostics.evidenceSourceCount ?? ''}`,
    `- 前端来源：${diagnostics.publicSourceCount ?? result.sources?.length ?? 0}`,
    `- 覆盖群：${Array.isArray(coverage.groups) ? coverage.groups.join('、') : ''}`,
    `- 覆盖日期：${Array.isArray(coverage.dates) ? coverage.dates.join('、') : ''}`,
    `- 覆盖检查：直接答案=${yesNo(coverage.hasDirectAnswer)}，成功案例=${yesNo(coverage.hasSuccessCase)}，失败边界=${yesNo(coverage.hasFailureBoundary)}，反例观点=${yesNo(coverage.hasCounterpoint)}`,
    '',
    '**精选来源**：',
    '',
    sourceTitles || '无来源',
    '',
    '**人工评分**：积极性 / 正确性 / 引用可靠性 / 覆盖度 / 边界说明：',
    '',
    '备注：',
    '',
  ];
}

function renderGroupTable(grouped) {
  const rows = Object.entries(grouped || {});
  if (rows.length === 0) {
    return '_No rows._';
  }

  return [
    '| Group | Total | Success | Avg latency | Avg sources | Avg query variants | Avg enriched |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      ([group, item]) =>
        `| ${group} | ${item.total} | ${item.ok} | ${item.avgLatencyMs} ms | ${item.avgSourceCount} | ${item.avgQueryVariantCount} | ${item.avgEnrichedSourceCount} |`,
    ),
  ].join('\n');
}

function renderFailureReasonTable(failureReasons) {
  const rows = Object.entries(failureReasons || {});
  if (rows.length === 0) {
    return '_No failure reasons recorded._';
  }

  return [
    '| Reason | Count |',
    '| --- | ---: |',
    ...rows.map(([reason, count]) => `| ${reason} | ${count} |`),
  ].join('\n');
}

function renderFailures(results) {
  const failures = results.filter((result) => !result.ok);
  if (!failures.length) {
    return ['_No failed requests._'];
  }
  return failures.map((result) =>
    `- ${result.id} (${result.failureReason || 'unknown'}): ${escapeMarkdown(result.error || `HTTP ${result.status}`)}`,
  );
}

function escapeTable(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function escapeMarkdown(value) {
  return String(value || '').replace(/\n/g, ' ');
}

function truncateReportText(value, maxLength) {
  const text = String(value || '');
  if (!maxLength || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function yesNo(value) {
  return value ? '是' : '否';
}

function defaultResultPath(provider) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeProvider = String(provider || 'provider').replace(/[^a-z0-9_-]+/gi, '-');
  return path.join(__dirname, 'results', `${stamp}-${safeProvider}.jsonl`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  try {
    const options = parseArgs();
    const result = await runEvaluation(options);
    if (result.dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            questions: result.questions.length,
            outputPath: result.outputPath,
            reportPath: result.reportPath,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      JSON.stringify(
        {
          outputPath: result.outputPath,
          reportPath: result.reportPath,
          summary: result.summary,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  classifyResponseFailure,
  classifyThrownFailure,
  isQuotaExceededResult,
  parseArgs,
  readQuestions,
  readResults,
  renderEvaluationReport,
  renderLocalRagChineseReport,
  renderReport,
  runEvaluation,
  runQuestion,
  selectQuestions,
  summarizeResults,
};
