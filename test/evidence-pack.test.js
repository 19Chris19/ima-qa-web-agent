const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildEvidencePack,
  cleanText,
  normalizeKnowledgeResults,
  sanitizePublicSource,
  truncateText,
} = require('../src/evidence-pack');

test('buildEvidencePack merges duplicate media evidence and keeps public sources sanitized', () => {
  const pack = buildEvidencePack(
    [
      {
        mediaId: 'media-1',
        title: ' 资料 A ',
        snippet: '<em>第一段证据</em>',
        matchedQuery: '原问题',
      },
      {
        mediaId: 'media-1',
        title: '资料 A',
        snippet: '第二段证据',
        matchedQuery: '改写问题',
      },
      {
        mediaId: 'media-2',
        title: '资料 B',
        snippet: '',
      },
    ],
    { maxSources: 3, maxSourceContentLength: 100 },
  );

  assert.equal(pack.evidence.length, 1);
  assert.equal(pack.evidence[0].mediaId, 'media-1');
  assert.deepEqual(pack.evidence[0].matchedQueries, ['原问题', '改写问题']);
  assert.match(pack.evidence[0].snippet, /第一段证据/);
  assert.match(pack.evidence[0].snippet, /第二段证据/);
  assert.deepEqual(pack.sources, [
    {
      index: 1,
      title: '资料 A',
      snippet: '第一段证据\n第二段证据',
    },
  ]);
  assert.equal(JSON.stringify(pack.sources).includes('media-1'), false);
});

test('buildEvidencePack caps evidence and reports profile diagnostics', () => {
  const pack = buildEvidencePack(
    [
      { title: 'A', snippet: 'a', evidenceType: 'search' },
      { title: 'B', snippet: 'b', evidenceType: 'profile' },
      { title: 'C', snippet: 'c', evidenceType: 'enriched', matchedQuery: 'query-c' },
    ],
    { maxSources: 3 },
  );

  assert.deepEqual(
    pack.sources.map((source) => source.title),
    ['A', 'B', 'C'],
  );
  assert.equal(pack.diagnostics.sourceCount, 3);
  assert.equal(pack.diagnostics.profileIncluded, true);
  assert.equal(pack.diagnostics.enrichedSourceCount, 1);
  assert.equal(pack.diagnostics.queryVariantCount, 1);
  assert.deepEqual(pack.diagnostics.evidenceTypes, { search: 1, profile: 1, enriched: 1 });
});

test('buildEvidencePack preserves matched query arrays when rebuilding evidence', () => {
  const pack = buildEvidencePack(
    [
      {
        mediaId: 'media-1',
        title: '资料 A',
        snippet: '第一段证据',
        matchedQueries: ['原问题', '关键词化'],
      },
      {
        mediaId: 'media-1',
        title: '资料 A',
        snippet: '第二段证据',
        matchedQuery: '同义改写',
      },
    ],
    { maxSources: 3 },
  );

  assert.deepEqual(pack.evidence[0].matchedQueries, ['原问题', '关键词化', '同义改写']);
  assert.deepEqual(pack.diagnostics.matchedQueries, ['原问题', '关键词化', '同义改写']);
});

test('normalizeKnowledgeResults keeps adjacent chunks and uses OpenAPI fallback fields', () => {
  const sources = normalizeKnowledgeResults(
    [
      { media_id: 'media-1', title: '群聊记录', highlight_content: '第一段经验' },
      { media_id: 'media-1', title: '群聊记录', highlight_content: '第二段经验' },
      { media_id: 'media-1', title: '重复片段', highlight_content: '第二段经验' },
      { file_id: 'file-1', file_name: '设备清单.md', summary: '相机、无人机和电脑配置建议' },
      {
        media_info: { media_id: 'nested-1', title: '嵌套资料标题' },
        chunk_content: '来自嵌套字段的片段',
      },
    ],
    { maxSources: 5, maxSnippetLength: 100 },
  );

  assert.deepEqual(sources, [
    { index: 1, mediaId: 'media-1', title: '群聊记录', snippet: '第一段经验' },
    { index: 2, mediaId: 'media-1', title: '群聊记录', snippet: '第二段经验' },
    {
      index: 3,
      mediaId: 'file-1',
      title: '设备清单.md',
      snippet: '相机、无人机和电脑配置建议',
    },
    { index: 4, mediaId: 'nested-1', title: '嵌套资料标题', snippet: '来自嵌套字段的片段' },
  ]);
});

test('text helpers clean and truncate source content', () => {
  assert.equal(cleanText(' <b>hello</b>\n world '), 'hello world');
  assert.equal(truncateText('abcdef', 4), 'abc…');
  assert.deepEqual(sanitizePublicSource({ index: 1, title: 'T', snippet: 'S', mediaId: 'secret' }), {
    index: 1,
    title: 'T',
    snippet: 'S',
  });
});
