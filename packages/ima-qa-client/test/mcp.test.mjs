import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.mjs';

test('MCP handshake discovers six tools and validates request keys without implicit asks', async () => {
  let asks = 0;
  const server = createServer({ status: async () => ({ ready: true }), ask: async a => { asks++; return { taskId: 't', status: 'running', requestKey: a.requestKey }; } });
  const client = new Client({ name: 'test-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    assert.equal((await client.listTools()).tools.length, 6);
    assert.equal((await client.callTool({ name: 'ima_qa_status', arguments: {} })).structuredContent.ready, true);
    assert.equal(asks, 0);
    const invalid = await client.callTool({ name: 'ima_qa_ask', arguments: { question: 'Q' } });
    assert.equal(invalid.isError, true); assert.equal(asks, 0);
    const result = await client.callTool({ name: 'ima_qa_ask', arguments: { question: 'Q', requestKey: 'one' } });
    assert.equal(result.structuredContent.status, 'running'); assert.equal(asks, 1);
  } finally { await client.close(); await server.close(); }
});

test('STDIO CLI completes actual SDK handshake without polluting stdout', async t => {
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { atomic } = await import('../src/config.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'ima-stdio-'));
  const path = join(dir, 'client.json');
  await atomic(path, { profiles: { default: { baseUrl: 'http://127.0.0.1:1', applicationId: 'test', clientId: 'test-client',
    knowledgeScopeRef: 'a'.repeat(64), apiToken: 'synthetic-api', internalServiceToken: 'synthetic-internal' } } });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../bin/ima-qa.mjs', import.meta.url)), 'mcp', '--config', path], stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 6);
    const result = await client.callTool({ name: 'ima_qa_status', arguments: {} });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes('synthetic-internal'));
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
