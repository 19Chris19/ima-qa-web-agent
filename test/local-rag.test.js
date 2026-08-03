const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSearchIndex, chunkRawMarkdown } = require('../src/local-rag-indexer');
const {
  LocalRAGClient,
  buildLocalQueryCandidates,
  filterEvidenceByRelevance,
  focusEvidenceCandidate,
  scoreChunks,
} = require('../src/local-rag-client');
const {
  classifyQuestion,
  disambiguateCandidates,
  scoreCoveragePriority,
  planLocalRagQuery,
  selectCoverageCandidates,
} = require('../src/local-rag-planner');

test('chunkRawMarkdown parses both raw chat markdown formats', () => {
  const groupOne = [
    '# Source Packet v1 - group1',
    '- group_alias: `group1`',
    '- source_title: `group1 2026-03-07`',
    '## Messages',
    '- [21:13:02] zhemu1: Blender 导出 GLB 变大，可以关闭法线和动画等无用数据。',
    '- [21:17:21] wxid_x: [图片]',
    '- [21:39:05] expert: 点云可以作为建图基础，再进行高斯。',
  ].join('\n');

  const groupTwo = [
    '# RAW 增强版：Group Two / 2026-03-22',
    '## 核心正文',
    '[2026-03-22T17:03:51+08:00] 颍川文远: 群聊内容也是技术手册，能关键词搜索就很好。',
    '[2026-03-22T17:06:22+08:00] Chris Lee: 机器人会默默整理群聊记录并做每日摘要。',
  ].join('\n');

  const chunks = [
    ...chunkRawMarkdown('root/group1/20260307_0500-2359_group1_openclaw_raw_chat.md', groupOne),
    ...chunkRawMarkdown('root/group2/20260322_0500-2359_group2_openclaw_raw_chat.md', groupTwo),
  ];

  assert.equal(chunks.length, 2);
  assert.match(chunks[0].snippet, /Blender 导出 GLB 变大/);
  assert.match(chunks[1].snippet, /关键词搜索/);
  assert.equal(chunks[0].group, 'group1');
});

test('LocalRAGClient retrieves evidence from a local index', async () => {
  const chunks = chunkRawMarkdown(
    'root/group1/20260307_0500-2359_group1_openclaw_raw_chat.md',
    [
      '# Source Packet v1 - group1',
      '- group_alias: `group1`',
      '## Messages',
      '- [21:13:02] zhemu1: Blender 导出 GLB 变大，可以关闭法线、动画等无用数据。',
      '- [21:13:40] expert: 是的，导出带了很多没用的数据。',
      '- [21:39:05] expert: 点云可以作为建图基础，然后再进行高斯。',
    ].join('\n'),
  );
  const index = buildSearchIndex(chunks);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-local-rag-'));
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'index.json'), JSON.stringify(index));

  const client = new LocalRAGClient({ indexDir: tempDir, maxSources: 3 });
  const evidencePack = await client.retrieveEvidencePack('Blender 导出的 GLB 为什么变大？');

  assert.equal(evidencePack.sources.length, 1);
  assert.match(evidencePack.sources[0].snippet, /关闭法线/);
  assert.equal(evidencePack.diagnostics.provider, 'local-rag-mimo');
  assert.equal(evidencePack.diagnostics.indexedChunkCount, chunks.length);
});

test('LocalRAGClient rejects off-domain generic questions instead of filling sources', async () => {
  const chunks = [
    {
      id: 'food-chat',
      title: 'group1 / 2026-03-07',
      snippet: '今天晚上大家讨论吃什么，有人说先吃饭再看模型。',
      group: 'group1',
      date: '2026-03-07',
    },
    {
      id: 'tech-chat',
      title: 'group1 / 2026-03-08',
      snippet: '3DGS 训练时显存不足可以降低图像分辨率。',
      group: 'group1',
      date: '2026-03-08',
    },
  ];
  const index = buildSearchIndex(chunks);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-local-rag-generic-'));
  fs.writeFileSync(path.join(tempDir, 'index.json'), JSON.stringify(index));

  const client = new LocalRAGClient({
    indexDir: tempDir,
    maxPublicSources: 10,
  });
  const evidencePack = await client.retrieveEvidencePack('今天晚上吃什么？');

  assert.deepEqual(evidencePack.sources, []);
  assert.equal(evidencePack.diagnostics.publicSourceCount, 0);
  assert.equal(evidencePack.diagnostics.relevanceGate.accepted, false);
  assert.match(evidencePack.diagnostics.relevanceGate.reason, /no_candidates|off_domain|generic/);
});

test('local search scores matching chunks with query variants', () => {
  const chunks = [
    { id: 'a', title: 'group1 / 2026-03-07', snippet: 'Blender 导出 GLB 变大 关闭法线 动画' },
    { id: 'b', title: 'group1 / 2026-03-08', snippet: '无人机 点云 高斯 建图' },
  ];
  const index = buildSearchIndex(chunks);
  const queries = buildLocalQueryCandidates('Blender GLB 文件变大怎么办？');
  const scored = scoreChunks(index, queries);

  assert.equal(scored[0].id, 'a');
  assert.ok(queries.length > 1);
});

test('local RAG planner classifies drone overlap questions as parameter setting', () => {
  const plan = planLocalRagQuery('无人机航拍做 3DGS 时重叠率怎么设置？');

  assert.equal(classifyQuestion('无人机航拍做 3DGS 时重叠率怎么设置？'), 'parameter_setting');
  assert.equal(plan.plannerType, 'parameter_setting');
  assert.ok(plan.queries.some((query) => query.includes('重叠率 重叠度 重合率 overlap')));
  assert.ok(plan.queries.some((query) => query.includes('航向重叠 旁向重叠')));
  assert.ok(plan.queries.some((query) => query.includes('视角多样性')));
  assert.ok(plan.queries.some((query) => query.includes('重建失败')));
});

test('local RAG planner expands weak workflow and troubleshooting themes', () => {
  const toolPlan = planLocalRagQuery('PostShot、BSD、LichtFeld Studio、RealityScan 在训练速度、显存占用和效果上有什么差异？');
  assert.equal(toolPlan.plannerType, 'tool_comparison');
  assert.ok(toolPlan.focusHints.includes('tool_comparison'));
  assert.ok(toolPlan.queries.some((query) => query.includes('PostShot BSD 对比')));

  const meshPlan = planLocalRagQuery('如何将3DGS模型转换成网格 Mesh 或用于3D打印？');
  assert.equal(meshPlan.plannerType, 'application_solution');
  assert.ok(meshPlan.focusHints.includes('mesh_printing'));
  assert.ok(meshPlan.queries.some((query) => query.includes('高斯转mesh Kiri 3D打印')));

  const materialPlan = planLocalRagQuery('对于包含透明或反光物体如玻璃、金属的场景需要特殊处理吗？');
  assert.ok(materialPlan.focusHints.includes('material_reflection'));

  const fourDPlan = planLocalRagQuery('什么是4DGS，它主要应用于人体动作和演唱会吗？');
  assert.ok(fourDPlan.focusHints.includes('four_d'));
});

test('local RAG planner disambiguates unrelated overlap hits', () => {
  const candidates = [
    {
      id: 'good',
      title: 'group2 / 2026-05-08',
      snippet: '无人机航拍采集时，关键不是重叠度，而是视角多样性。',
    },
    {
      id: 'bad',
      title: 'group1 / 2026-04-11',
      snippet: '这里讨论的是网格重叠面清理和 UI 画面重叠。',
    },
  ];
  const result = disambiguateCandidates('无人机航拍 3DGS 重叠率怎么设置？', candidates);

  assert.deepEqual(result.kept.map((candidate) => candidate.id), ['good']);
  assert.deepEqual(result.discarded.map((candidate) => candidate.id), ['bad']);
});

test('coverage selection keeps direct answers, success cases, boundaries, and counterpoints', () => {
  const candidates = [
    {
      id: 'direct',
      group: 'group4',
      date: '2026-06-09',
      title: 'group4 / 2026-06-09',
      snippet: '航向重叠率 ≥80%，旁向重叠率 ≥70%，GSD ≤3cm。',
      score: 10,
    },
    {
      id: 'success',
      group: 'group3',
      date: '2026-07-29',
      title: 'group3 / 2026-07-29',
      snippet: '照片间 75%–85% 重叠，实际航拍稳定成片。',
      score: 9,
    },
    {
      id: 'boundary',
      group: 'group2',
      date: '2026-05-08',
      title: 'group2 / 2026-05-08',
      snippet: '重叠度 60，再低对不上了；照片太多会爆显存。',
      score: 8,
    },
    {
      id: 'counter',
      group: 'group2',
      date: '2026-05-08',
      title: 'group2 / 2026-05-08',
      snippet: '关键不是重叠度，而是视角多样性，不要只堆重叠率。',
      score: 7,
    },
  ];
  const plan = { plannerType: 'parameter_setting' };
  const result = selectCoverageCandidates(candidates, plan, { maxSources: 4 });

  assert.deepEqual(result.selected.map((candidate) => candidate.id), [
    'direct',
    'success',
    'boundary',
    'counter',
  ]);
  assert.deepEqual(result.coverage.groups.sort(), ['group2', 'group3', 'group4']);
  assert.equal(result.coverage.hasDirectAnswer, true);
  assert.equal(result.coverage.hasSuccessCase, true);
  assert.equal(result.coverage.hasFailureBoundary, true);
  assert.equal(result.coverage.hasCounterpoint, true);
});

test('coverage selection prioritizes hard drone overlap thresholds over noisy generic evidence', () => {
  const noisyGeneric = {
    id: 'generic',
    group: 'group1',
    date: '2026-05-08',
    title: 'group1 / 2026-05-08',
    snippet: '【ima知识库】群聊知识AI答疑 卡片解析 无人机航拍需要注意航线和拍摄数量。',
    score: 50,
  };
  const threshold = {
    id: 'threshold',
    group: 'group2',
    date: '2026-06-09',
    title: 'group2 / 2026-06-09',
    snippet: '3DGS 航拍采集建议航向重叠率 ≥80%，旁向重叠率 ≥70%，GSD 控制在合理范围。',
    score: 20,
  };
  const plan = { plannerType: 'parameter_setting' };
  const result = selectCoverageCandidates([noisyGeneric, threshold], plan, { maxSources: 2 });

  assert.equal(result.selected[0].id, 'threshold');
  assert.ok(scoreCoveragePriority(threshold, plan) > scoreCoveragePriority(noisyGeneric, plan));
});

test('coverage selection prioritizes focused workflow evidence over generic high scores', () => {
  const generic = {
    id: 'generic',
    group: 'group1',
    date: '2026-04-01',
    title: 'group1 / 2026-04-01',
    snippet: '3DGS 采集可以试试换个思路，多高度采集就 ok。',
    score: 80,
  };
  const mesh = {
    id: 'mesh',
    group: 'group2',
    date: '2026-07-03',
    title: 'group2 / 2026-07-03',
    snippet: 'Kiri 是高斯转mesh，用一般的3D打印机也能正常打；高斯模型需要先网格化。',
    score: 20,
  };
  const plan = {
    plannerType: 'application_solution',
    focusHints: ['mesh_printing'],
  };
  const result = selectCoverageCandidates([generic, mesh], plan, { maxSources: 2 });

  assert.equal(result.selected[0].id, 'mesh');
  assert.ok(scoreCoveragePriority(mesh, plan) > scoreCoveragePriority(generic, plan));
});

test('relevance gate keeps public sources dynamic rather than mechanically filling the cap', () => {
  const plan = planLocalRagQuery('PostShot、BSD 在训练速度和效果上有什么差异？');
  const candidates = [
    {
      id: 'strong-tool',
      title: 'group1 / 2026-07-01',
      snippet: 'PostShot 和 BSD 对比时，群里认为 PostShot 细节更好，BSD 更稳定，训练速度和显存占用要结合数据量看。',
      matchedTerms: ['PostShot', 'BSD', '训练速度', '效果'],
      score: 80,
    },
    {
      id: 'medium-tool',
      title: 'group2 / 2026-07-02',
      snippet: 'LichtFeld Studio、RealityScan、SuperSplat 和 PostShot 的渲染平台定位不同。',
      matchedTerms: ['PostShot', '渲染平台'],
      score: 50,
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `generic-${index}`,
      title: `group3 / 2026-07-${String(index + 1).padStart(2, '0')}`,
      snippet: '今天大家聊了一些软件体验，但没有提到具体工具差异。',
      matchedTerms: ['今天', '软件'],
      score: 100 - index,
    })),
  ];

  const result = filterEvidenceByRelevance(candidates, {
    question: 'PostShot、BSD 在训练速度和效果上有什么差异？',
    plan,
    maxEvidenceSources: 18,
    maxPublicSources: 10,
  });

  assert.equal(result.diagnostics.accepted, true);
  assert.ok(result.publicEvidence.length < 10);
  assert.deepEqual(result.publicEvidence.map((source) => source.id), ['strong-tool', 'medium-tool']);
  assert.ok(result.diagnostics.droppedEvidenceCandidates >= 12);
});

test('focusEvidenceCandidate trims share-card noise and centers parameter evidence', () => {
  const leadingNoise = [
    '【ima知识库】群聊知识AI答疑 卡片解析 https://mp.weixin.qq.com/s/example [音乐]',
    '【ima知识库】群聊知识AI答疑 卡片解析 公众号摘要: 使用 MipMap 采集时需确保航向重叠率 ≥80%，旁向重叠率 ≥70%，GSD≤3厘米。',
  ].join('\n');
  const filler = '一些泛泛的聊天内容。'.repeat(320);
  const snippet = `${leadingNoise}\n${filler}实际采集时建议同时注意视角多样性和照片数/显存约束。`;

  const focused = focusEvidenceCandidate(
    {
      id: 'noisy-threshold',
      title: 'group2 / 2026-06-09',
      snippet,
      score: 10,
    },
    {
      plan: { plannerType: 'parameter_setting' },
      focusTerms: ['航向重叠', '旁向重叠'],
    },
  );

  assert.equal(focused.focused, true);
  assert.match(focused.snippet, /航向重叠率 ≥80%/);
  assert.match(focused.snippet, /旁向重叠率 ≥70%/);
  assert.doesNotMatch(focused.snippet, /群聊知识AI答疑|mp\.weixin\.qq\.com|\[音乐\]/);
  assert.ok(focused.snippet.length <= 2202);
});

test('focusEvidenceCandidate centers non-parameter workflow evidence', () => {
  const snippet = `${'普通讨论。'.repeat(620)}Kiri 是高斯转mesh，用一般的3D打印机也能正常打，但颜色和球谐函数可能影响打印结果。`;
  const focused = focusEvidenceCandidate(
    {
      id: 'mesh-source',
      title: 'group2 / 2026-07-03',
      snippet,
      score: 10,
    },
    {
      plan: { plannerType: 'application_solution', focusHints: ['mesh_printing'] },
      focusTerms: [],
      question: '如何将3DGS模型转换成网格 Mesh 或用于3D打印？',
    },
  );

  assert.equal(focused.focused, true);
  assert.match(focused.snippet, /Kiri 是高斯转mesh/);
  assert.match(focused.snippet, /3D打印机/);
  assert.ok(focused.snippet.length <= 2202);
});

test('LocalRAGClient reports expanded diagnostics without exposing internal media ids', async () => {
  const chunks = [
    {
      id: 'root/group4/20260609.md#1',
      mediaId: 'root/group4/20260609.md#1',
      title: 'group4 / 2026-06-09',
      group: 'group4',
      date: '2026-06-09',
      snippet: '无人机航拍 3DGS 航向重叠率 ≥80%，旁向重叠率 ≥70%，GSD ≤3cm。',
    },
    {
      id: 'root/group2/20260508.md#1',
      mediaId: 'root/group2/20260508.md#1',
      title: 'group2 / 2026-05-08',
      group: 'group2',
      date: '2026-05-08',
      snippet: '关键不是重叠度，而是视角多样性。60 再低对不上，照片太多会爆显存。',
    },
  ];
  const index = buildSearchIndex(chunks);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-local-rag-v2-'));
  fs.writeFileSync(path.join(tempDir, 'index.json'), JSON.stringify(index));

  const client = new LocalRAGClient({
    indexDir: tempDir,
    queryLimit: 12,
    perQueryCandidates: 20,
    maxCandidates: 100,
    maxEvidenceSources: 8,
    maxPublicSources: 2,
  });
  const evidencePack = await client.retrieveEvidencePack('无人机航拍做 3DGS 时重叠率怎么设置？');

  assert.equal(evidencePack.diagnostics.plannerType, 'parameter_setting');
  assert.ok(evidencePack.diagnostics.queryVariantCount >= 7);
  assert.ok(evidencePack.diagnostics.firstPassCandidateCount >= 1);
  assert.ok(Array.isArray(evidencePack.diagnostics.secondPassTerms));
  assert.ok(Number.isFinite(evidencePack.diagnostics.discardedByDisambiguation));
  assert.ok(evidencePack.diagnostics.publicSourceCount <= 2);
  assert.equal(JSON.stringify(evidencePack.diagnostics).includes('root/group'), false);
});
