const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(t, loader, sources = 1) {
  const dom = new JSDOM('<div id="answer"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, timers = new Map(), signals = [], created = [], revoked = [];
  let now = 1000, nextId = 0;
  w.setTimeout = (fn, delay = 0) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; };
  w.clearTimeout = id => timers.delete(id);
  Object.defineProperty(w.performance, 'now', { value: () => now });
  w.Blob = Blob;
  w.HTMLImageElement.prototype.decode = async () => {};
  w.URL.createObjectURL = () => { const url = `blob:test-${created.length}`; created.push(url); return url; };
  w.URL.revokeObjectURL = url => revoked.push(url);
  w.eval(fs.readFileSync(path.join(__dirname, '../public/chat-presentation.js'), 'utf8'));
  const ui = w.ChatPresentation, answer = w.document.querySelector('#answer');
  const citationMap = { 'index:42': { type: 'web', sources: Array.from({ length: sources }, (_, i) => ({
    url: `https://example.org/${i}`, sourceId: (i ? 'b' : 'a').repeat(64), title: `Source ${i}`, snippet: 'Keep this text',
  })) } };
  const options = { conversationId: 'conv', taskId: 'task', citationMap,
    loadPreview: (reference, signal) => { signals.push(signal); return loader(reference, signal); } };
  answer.innerHTML = ui.citation({ href: '@index-ref?id=42', text: '7' }, options);
  ui.bind(answer, options);
  const marker = answer.querySelector('[data-citation-key]');
  const open = () => marker.dispatchEvent(new w.MouseEvent('pointerover', { bubbles: true }));
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn(); await flush();
    }
    now = end; await flush();
  };
  t.after(() => { ui.closeCard(); dom.window.close(); });
  return { w, ui, answer, marker, options, open, advance, signals, created, revoked,
    covers: () => w.document.querySelectorAll('.chat-source-cover'), card: () => w.document.querySelector('.chat-citation-card') };
}
const image = () => ({ blob: new Blob(['cover'], { type: 'image/png' }) });

test('two seconds starts at the request, retains text, aborts and drops an uncooperative late result', async t => {
  let finish;
  const p = setup(t, () => new Promise(resolve => { finish = resolve; }));
  p.open(); assert.match(p.card().textContent, /Keep this text/);
  await p.advance(299); assert.equal(p.signals.length, 0);
  await p.advance(1); assert.equal(p.signals.length, 1);
  await p.advance(1999); assert.equal(p.signals[0].aborted, false);
  await p.advance(1); assert.equal(p.signals[0].aborted, true);
  finish(image()); await flush();
  assert.equal(p.covers().length, 0); assert.equal(p.created.length, 0);
  assert.match(p.card().textContent, /Keep this text/);
  assert.equal(p.card().querySelector('a').href, 'https://example.org/0');
  p.card().querySelector('.chat-citation-sources').dispatchEvent(new p.w.Event('scroll'));
  p.open(); await p.advance(400);
  assert.equal(p.signals.length, 1, 'scroll and repeated activation never retry');
  const updated = structuredClone(p.options.citationMap); updated['index:42'].sources[0].snippet = 'Late metadata';
  p.ui.bind(p.answer, { ...p.options, citationMap: updated }); await p.advance(400);
  assert.match(p.card().textContent, /Late metadata/);
  assert.equal(p.signals.length, 1, 'metadata updates cannot restart the expired budget');
});

test('image decode is inside the same deadline and unfinished blob URLs are revoked', async t => {
  let finishDecode;
  const p = setup(t, async () => image());
  p.w.HTMLImageElement.prototype.decode = () => new Promise(resolve => { finishDecode = resolve; });
  p.open(); await p.advance(300);
  assert.equal(p.created.length, 1); assert.equal(p.covers().length, 0);
  await p.advance(2000);
  assert.equal(p.signals[0].aborted, true); assert.deepEqual(p.revoked, p.created);
  finishDecode(); await flush();
  assert.equal(p.covers().length, 0); assert.match(p.card().textContent, /Keep this text/);
});

test('a fast decoded cover remains visible and is cleaned up on close', async t => {
  const p = setup(t, async () => image());
  p.open(); await p.advance(300);
  assert.equal(p.covers().length, 1);
  await p.advance(3000); assert.equal(p.covers().length, 1);
  const updated = structuredClone(p.options.citationMap); updated['index:42'].sources[0].snippet = 'Updated text';
  p.ui.bind(p.answer, { ...p.options, citationMap: updated });
  assert.equal(p.covers().length, 1); assert.match(p.card().textContent, /Updated text/);
  assert.equal(p.signals.length, 1);
  p.ui.closeCard(); assert.deepEqual(p.revoked, p.created);
});

test('multiple sources share one budget rather than receiving two seconds each', async t => {
  let finishSecond, calls = 0;
  const p = setup(t, async () => {
    if (++calls === 1) { await new Promise(resolve => p.w.setTimeout(resolve, 1100)); return image(); }
    return new Promise(resolve => { finishSecond = resolve; });
  }, 2);
  p.open(); await p.advance(1400); assert.equal(calls, 2); assert.equal(p.covers().length, 1);
  await p.advance(900); assert.equal(p.signals[0].aborted, true);
  finishSecond(image()); await flush(); assert.equal(p.covers().length, 1);
});

test('closing a hung loader permits a fresh explicit view without waiting for the old callback', async t => {
  let finishOld, calls = 0;
  const p = setup(t, () => ++calls === 1 ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve(image()));
  p.open(); await p.advance(300); p.ui.closeCard(); assert.equal(p.signals[0].aborted, true);
  p.open(); await p.advance(300); assert.equal(calls, 2); assert.equal(p.covers().length, 1);
  finishOld(image()); await flush(); assert.equal(p.covers().length, 1); assert.equal(p.created.length, 1);
});

test('the authenticated loader cancels a stalled image stream at the display deadline', async t => {
  let cancelCount = 0, calls = 0;
  const p = setup(t, (reference, signal) => p.ui.previewLoader(async () => {
    if (++calls === 1) return { ok: true, json: async () => ({ status: 'ready' }) };
    return { ok: true, headers: new Headers({ 'Content-Type': 'image/png' }), body: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); }, cancel() { cancelCount++; },
    }) };
  }, '/api/source-preview')(reference, signal));
  p.open(); await p.advance(300); assert.equal(calls, 2);
  await p.advance(2000);
  assert.equal(cancelCount, 1); assert.equal(p.covers().length, 0); assert.equal(p.created.length, 0);
});

test('touch starts the same deadline immediately after explicit activation', async t => {
  const p = setup(t, () => new Promise(() => {}));
  p.w.matchMedia = () => ({ matches: true });
  p.marker.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await p.advance(0); assert.equal(p.signals.length, 1); assert.ok(p.card().classList.contains('chat-citation-sheet'));
  await p.advance(2000); assert.equal(p.signals[0].aborted, true); assert.match(p.card().textContent, /Keep this text/);
});
