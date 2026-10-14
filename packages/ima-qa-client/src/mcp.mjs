import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const waitSeconds = z.number().min(0).max(25).default(0);
const offset = z.number().int().nonnegative().default(0);
// Pagination covers the entire serialized result, including large source arrays.
export function page(value, start = 0) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 16000 && start === 0) return value;
  return { encoding: 'json', offset: start, totalCharacters: serialized.length,
    chunk: serialized.slice(start, start + 16000), nextOffset: start + 16000 < serialized.length ? start + 16000 : null,
    taskId: value.taskId, conversationId: value.conversationId, status: value.status, complete: value.complete,
    instruction: 'Read remaining pages with get_task or get_conversation; concatenate chunks before JSON parsing. CLI export writes the complete result.' };
}
export function createServer(client) {
  const server = new McpServer({ name: 'ima-qa', version: '0.1.0' });
  const register = (name, description, inputSchema, fn, readOnly = true) => server.registerTool(name, {
    description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: name === 'ima_qa_cancel', openWorldHint: true },
  }, async args => {
    try {
      const value = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.code || 'client_error',
        taskId: error.taskId, requestKey: error.requestKey, conversationId: error.conversationId, retryable: error.retryable }) }] };
    }
  });
  register('ima_qa_status', 'Check configured IMA Provider readiness without asking a question.', {}, () => client.status());
  register('ima_qa_ask', 'Ask the real IMA web knowledge session. Choose a unique requestKey once per logical question; reuse it on retry. Follow up with the returned conversationId. A running result is not a failure; poll get_task. Never resubmit indeterminate tasks.', {
    question: z.string().min(1), requestKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    conversationId: z.string().optional(), sourceIntent: z.enum(['knowledge', 'web']).default('knowledge'), waitSeconds,
  }, async args => page(await client.ask(args)), false);
  register('ima_qa_get_task', 'Read or wait for a task. Disconnect and timeout never cancel it. Read all pages before summarizing; wait only on offset zero.', {
    taskId: z.string(), waitSeconds, offset,
  }, async args => page(await client.task(args.taskId, { waitSeconds: args.offset ? 0 : args.waitSeconds }), args.offset));
  register('ima_qa_get_conversation', 'Read retained conversation history. History may contain capped sources; archive task results for complete evidence.', {
    conversationId: z.string(), offset,
  }, async args => page(await client.conversation(args.conversationId), args.offset));
  register('ima_qa_cancel', 'Explicitly cancel a task only when the user wants it stopped.', { taskId: z.string() }, args => client.cancel(args.taskId), false);
  return server;
}
export async function serve(client) { const server = createServer(client); await server.connect(new StdioServerTransport()); return server; }
