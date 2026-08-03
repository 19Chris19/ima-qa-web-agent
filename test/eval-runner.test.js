const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadEvalRunner() {
  return import(pathToFileURL(path.join(__dirname, '..', 'eval', 'run-eval.mjs')));
}

test('eval runner reads, filters, and summarizes question sets', async () => {
  const { parseArgs, readQuestions, selectQuestions, summarizeResults } = await loadEvalRunner();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-eval-'));
  const questionsPath = path.join(tempDir, 'questions.jsonl');
  await fs.writeFile(
    questionsPath,
    [
      JSON.stringify({
        id: 'q1',
        suite: 'suite',
        category: 'basic',
        difficulty: 'basic',
        question: '问题 1',
      }),
      JSON.stringify({
        id: 'q2',
        suite: 'suite',
        category: 'advanced',
        difficulty: 'advanced',
        question: '问题 2',
      }),
      '',
    ].join('\n'),
  );

  const args = parseArgs([
    '--base-url',
    'http://127.0.0.1:3117/',
    '--questions',
    questionsPath,
    '--category',
    'basic',
    '--limit',
    '1',
  ]);
  const questions = await readQuestions(questionsPath);
  const selected = selectQuestions(questions, args);
  const summary = summarizeResults([
    { ok: true, latencyMs: 100, sources: [{ title: 'A' }], category: 'basic', difficulty: 'basic' },
    { ok: false, latencyMs: 200, sources: [], category: 'basic', difficulty: 'advanced' },
  ]);

  assert.equal(args.baseUrl, 'http://127.0.0.1:3117');
  assert.equal(questions.length, 2);
  assert.deepEqual(selected.map((question) => question.id), ['q1']);
  assert.equal(summary.total, 2);
  assert.equal(summary.ok, 1);
  assert.equal(summary.avgLatencyMs, 150);
});

test('eval runner supports resume and only-failed selection from previous JSONL results', async () => {
  const { parseArgs, readResults, selectQuestions } = await loadEvalRunner();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-eval-select-'));
  const resultsPath = path.join(tempDir, 'previous.jsonl');
  await fs.writeFile(
    resultsPath,
    [
      JSON.stringify({ id: 'q1', ok: true }),
      JSON.stringify({ id: 'q2', ok: false, failureReason: 'openapi_quota_exceeded' }),
      '',
    ].join('\n'),
  );

  const questions = [
    { id: 'q1', category: 'rendering_application', difficulty: 'basic' },
    { id: 'q2', category: 'rendering_application', difficulty: 'advanced' },
    { id: 'q3', category: 'advanced_troubleshooting', difficulty: 'advanced' },
  ];
  const previousResults = await readResults(resultsPath);
  const resumeArgs = parseArgs(['--resume', '--from-results', resultsPath]);
  const failedArgs = parseArgs([
    '--only-failed',
    '--from-results',
    resultsPath,
    '--category',
    'rendering_application',
  ]);

  assert.equal(resumeArgs.resume, true);
  assert.equal(failedArgs.onlyFailed, true);
  assert.deepEqual(
    selectQuestions(questions, { ...resumeArgs, previousResults }).map((question) => question.id),
    ['q2', 'q3'],
  );
  assert.deepEqual(
    selectQuestions(questions, { ...failedArgs, previousResults }).map((question) => question.id),
    ['q2'],
  );
});

test('eval runner posts questions with eval diagnostics header and writes reports', async () => {
  const { runEvaluation } = await loadEvalRunner();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-eval-run-'));
  const questionsPath = path.join(tempDir, 'questions.jsonl');
  const outputPath = path.join(tempDir, 'results.jsonl');
  const reportPath = path.join(tempDir, 'report.md');
  await fs.writeFile(
    questionsPath,
    `${JSON.stringify({
      id: 'q1',
      suite: 'suite',
      category: 'basic',
      difficulty: 'basic',
      question: '3DGS 是什么？',
    })}\n`,
  );

  const requests = [];
  const fetchMock = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(
      JSON.stringify({
        success: true,
        answer: '3DGS 是三维高斯泼溅。[1]',
        sources: [{ index: 1, title: '资料 A', snippet: '3DGS 片段' }],
        diagnostics: {
          matchedQueries: ['3DGS 是什么？', '3DGS'],
          sourceCount: 1,
          profileIncluded: false,
        },
        requestId: 'request-1',
      }),
      { status: 200 },
    );
  };

  const result = await runEvaluation(
    {
      baseUrl: 'http://127.0.0.1:3117',
      category: '',
      concurrency: 1,
      delayMs: 0,
      difficulty: '',
      dryRun: false,
      limit: 0,
      out: outputPath,
      provider: 'openapi-mimo',
      questions: questionsPath,
      report: reportPath,
      timeoutMs: 1000,
      token: 'secret-token',
    },
    fetchMock,
  );

  const jsonl = await fs.readFile(outputPath, 'utf8');
  const report = await fs.readFile(reportPath, 'utf8');
  const row = JSON.parse(jsonl.trim());

  assert.equal(requests[0].url, 'http://127.0.0.1:3117/api/ask');
  assert.equal(requests[0].options.headers['X-IMA-QA-Eval'], '1');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-token');
  assert.deepEqual(requests[0].body, { question: '3DGS 是什么？' });
  assert.equal(result.summary.ok, 1);
  assert.equal(row.ok, true);
  assert.equal(row.answer, '3DGS 是三维高斯泼溅。[1]');
  assert.deepEqual(row.diagnostics.matchedQueries, ['3DGS 是什么？', '3DGS']);
  assert.match(report, /Manual Scoring Sheet/);
  assert.equal(report.includes('secret-token'), false);
});

test('eval runner writes Chinese review reports for local RAG provider', async () => {
  const { runEvaluation } = await loadEvalRunner();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-eval-local-rag-'));
  const questionsPath = path.join(tempDir, 'questions.jsonl');
  const outputPath = path.join(tempDir, 'results.jsonl');
  const reportPath = path.join(tempDir, 'report.md');
  await fs.writeFile(
    questionsPath,
    `${JSON.stringify({
      id: 'q-local',
      suite: 'suite',
      category: 'capture_devices',
      difficulty: 'intermediate',
      question: '无人机航拍做 3DGS 时重叠率怎么设置？',
    })}\n`,
  );

  const fetchMock = async () =>
    new Response(
      JSON.stringify({
        success: true,
        answer: '航向重叠率建议 ≥80%，旁向重叠率建议 ≥70%。[1]',
        sources: [{ index: 1, title: 'group4 / 2026-06-09', snippet: '航向≥80，旁向≥70。' }],
        diagnostics: {
          provider: 'local-rag-mimo',
          plannerType: 'parameter_setting',
          queryVariantCount: 9,
          firstPassCandidateCount: 120,
          secondPassTerms: ['视角多样性', '60%'],
          secondPassCandidateCount: 40,
          dedupedCandidateCount: 80,
          discardedByDisambiguation: 12,
          evidenceSourceCount: 18,
          publicSourceCount: 10,
          coverage: {
            groups: ['group2', 'group4'],
            dates: ['2026-05-08', '2026-06-09'],
            hasDirectAnswer: true,
            hasSuccessCase: true,
            hasFailureBoundary: true,
            hasCounterpoint: true,
          },
        },
        requestId: 'request-local',
      }),
      { status: 200 },
    );

  await runEvaluation(
    {
      baseUrl: 'http://127.0.0.1:3121',
      category: '',
      concurrency: 1,
      delayMs: 0,
      difficulty: '',
      dryRun: false,
      limit: 0,
      out: outputPath,
      provider: 'local-rag-mimo',
      questions: questionsPath,
      report: reportPath,
      timeoutMs: 1000,
      token: '',
    },
    fetchMock,
  );

  const report = await fs.readFile(reportPath, 'utf8');
  assert.match(report, /Provider C 本地知识调度评测报告/);
  assert.match(report, /一问一答/);
  assert.match(report, /planner：parameter_setting/);
  assert.match(report, /覆盖检查：直接答案=是/);
  assert.equal(report.includes('Manual Scoring Sheet'), false);
});

test('eval runner stops early and writes a partial report when Provider B quota is exceeded', async () => {
  const { runEvaluation } = await loadEvalRunner();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-eval-quota-'));
  const questionsPath = path.join(tempDir, 'questions.jsonl');
  const outputPath = path.join(tempDir, 'results.jsonl');
  const reportPath = path.join(tempDir, 'report.md');
  await fs.writeFile(
    questionsPath,
    [
      { id: 'q1', suite: 'suite', category: 'basic', difficulty: 'basic', question: '问题 1' },
      { id: 'q2', suite: 'suite', category: 'basic', difficulty: 'basic', question: '问题 2' },
      { id: 'q3', suite: 'suite', category: 'basic', difficulty: 'basic', question: '问题 3' },
    ].map((row) => JSON.stringify(row)).join('\n'),
  );

  const requests = [];
  const fetchMock = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (requests.length === 1) {
      return new Response(
        JSON.stringify({
          success: true,
          answer: '答案 1',
          sources: [{ index: 1, title: '资料 A', snippet: '片段 A' }],
          diagnostics: {
            matchedQueries: ['问题 1', '关键词'],
            queryVariantCount: 2,
            sourceCount: 1,
            enrichedSourceCount: 1,
          },
          requestId: 'request-1',
        }),
        { status: 200 },
      );
    }
    if (requests.length === 2) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'IMA OpenAPI 今日额度已用尽，请明日额度恢复后继续评测',
          failureReason: 'openapi_quota_exceeded',
          requestId: 'request-2',
        }),
        { status: 429 },
      );
    }
    throw new Error('runner should stop before question 3');
  };

  const result = await runEvaluation(
    {
      baseUrl: 'http://127.0.0.1:3120',
      category: '',
      concurrency: 1,
      delayMs: 0,
      difficulty: '',
      dryRun: false,
      fromResults: '',
      limit: 0,
      onlyFailed: false,
      out: outputPath,
      provider: 'openapi-mimo',
      questions: questionsPath,
      report: reportPath,
      resume: false,
      timeoutMs: 1000,
      token: '',
    },
    fetchMock,
  );

  const rows = (await fs.readFile(outputPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const report = await fs.readFile(reportPath, 'utf8');

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.body.question), ['问题 1', '问题 2']);
  assert.equal(result.summary.stoppedEarly, true);
  assert.equal(result.summary.stopReason, 'openapi_quota_exceeded');
  assert.equal(result.summary.failureReasons.openapi_quota_exceeded, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].queryVariantCount, 2);
  assert.equal(rows[0].enrichedSourceCount, 1);
  assert.equal(rows[1].failureReason, 'openapi_quota_exceeded');
  assert.match(report, /Stopped early \| yes/);
  assert.match(report, /openapi_quota_exceeded/);
});
