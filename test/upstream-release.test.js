const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIMAWebAgentStream } = require('../src/ima-upstream-protocol');
const { sanitizeKnowledgeBoundAnswer } = require('../src/app');

async function collect(blocks) {
  const response = new Response(blocks.join('\n\n') + '\n\n');
  const events = [];
  for await (const event of parseIMAWebAgentStream(response)) events.push(event);
  return events;
}

test('controls do not interrupt a semantic answer and terminal is required', async () => {
  const events = await collect(['event: ping\ndata: {}', 'event: MESSAGE\ndata: {"Text":"answer"}', 'event: COMPLETED\ndata: {"Code":0}']);
  assert.deepEqual(events.map(e => e.type), ['delta', 'done']);
  await assert.rejects(collect(['event: MESSAGE\ndata: {"Text":"partial"}']), /upstream_terminal_missing/);
});

test('duplicate and failed terminals cannot become successful answers', async () => {
  await assert.rejects(collect(['event: COMPLETED\ndata: {"Code":0}', 'event: COMPLETED\ndata: {"Code":0}']), /upstream_terminal_duplicate/);
  await assert.rejects(collect(['event: COMPLETED\ndata: {"Code":41}']));
});

test('answer boundary preserves ordinary text', () => {
  assert.equal(sanitizeKnowledgeBoundAnswer('A simple answer.'), 'A simple answer.');
});
