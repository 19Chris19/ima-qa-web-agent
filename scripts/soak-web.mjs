import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import protocol from '../src/ima-upstream-protocol.js';

const duration = Number(process.env.SOAK_DURATION_MS || 1800000);
if (!Number.isFinite(duration) || duration < 1) throw new Error('invalid duration');
const started = Date.now();
const initialHeap = process.memoryUsage().heapUsed;
let cycles = 0;
while (Date.now() - started < duration) {
  for (const complete of [true, false]) {
    const response = new Response('event: MESSAGE\ndata: {"Text":"synthetic"}\n\n' +
      (complete ? 'event: COMPLETED\ndata: {"Code":0}\n\n' : ''));
    let terminal = 0;
    try {
      for await (const event of protocol.parseIMAWebAgentStream(response)) terminal += Number(event.type === 'done');
      assert.equal(complete, true);
      assert.equal(terminal, 1);
    } catch (error) {
      assert.equal(complete, false);
      assert.equal(error.code, 'upstream_terminal_missing');
    }
  }
  cycles++;
  if (cycles % 500 === 0) {
    global.gc?.();
    assert.ok(process.memoryUsage().heapUsed - initialHeap < 64 * 1024 * 1024);
  }
  await delay(20);
}
console.log(JSON.stringify({ complete: true, elapsedMs: Date.now() - started, cycles }));
