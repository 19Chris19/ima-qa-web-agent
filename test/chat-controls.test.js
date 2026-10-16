'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function fixture(t, reduced = false) {
  const dom = new JSDOM('<main id="log" tabindex="0"></main><button id="latest" hidden></button>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, log = w.document.querySelector('#log'), button = w.document.querySelector('#latest');
  let height = 1000, top = 500, clock = 10, sequence = 0, following = true;
  const frames = new Map();
  Object.defineProperties(log, { scrollHeight: { get: () => height }, clientHeight: { value: 500 },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(height - 500, value)); } } });
  w.matchMedia = () => ({ matches: reduced });
  w.performance.now = () => clock;
  w.requestAnimationFrame = fn => { frames.set(++sequence, fn); return sequence; };
  w.cancelAnimationFrame = id => frames.delete(id);
  w.eval(fs.readFileSync(path.resolve(__dirname, '../public/chat-controls.js'), 'utf8'));
  const control = w.ChatControls.latest({ log, button, following: () => following, setFollowing: value => { following = value; } });
  return { w, log, button, control, frames,
    get following() { return following; },
    grow(value) { height = value; control.pin(); },
    scroll(value) { top = value; log.dispatchEvent(new w.Event('scroll')); },
    input(deltaY) { log.dispatchEvent(new w.WheelEvent('wheel', { deltaY })); },
    advance(ms) { clock += ms; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); },
  };
}

test('latest has hysteresis, preserves manual reading and resumes at the actual bottom', t => {
  const p = fixture(t);
  p.log.dispatchEvent(new p.w.TouchEvent('touchstart', { touches: [] })); // Merely touching text is not a scroll away.
  p.grow(1100); assert.equal(p.following, true); assert.equal(p.log.scrollTop, 600);
  p.input(-1); p.scroll(550); assert.equal(p.button.dataset.visible, 'false');
  p.grow(1400); assert.equal(p.log.scrollTop, 550); assert.equal(p.button.dataset.visible, 'true');
  p.input(1); p.scroll(820); assert.equal(p.button.dataset.visible, 'true'); // 80px retains visible state.
  p.scroll(860); assert.equal(p.button.dataset.visible, 'false'); assert.equal(p.button.tabIndex, -1);
  assert.equal(p.following, true);
});

test('pointer jump is interruptible and never pulls a reader back after a gesture', t => {
  const p = fixture(t);
  p.input(-1); p.scroll(100);
  p.button.dispatchEvent(new p.w.MouseEvent('click', { detail: 1 }));
  p.advance(80); assert.ok(p.log.scrollTop > 100 && p.log.scrollTop < 500);
  p.input(-10); const stopped = p.log.scrollTop;
  p.advance(300); p.grow(1500);
  assert.equal(p.frames.size, 0); assert.equal(p.log.scrollTop, stopped); assert.equal(p.following, false);
});

for (const reduced of [false, true]) test(`keyboard/reduced=${reduced}: jump has no waiting frames`, t => {
  const p = fixture(t, reduced);
  p.input(-1); p.scroll(100);
  p.button.dispatchEvent(new p.w.MouseEvent('click', { detail: reduced ? 1 : 0 }));
  assert.equal(p.log.scrollTop, 500); assert.equal(p.frames.size, 0); assert.equal(p.button.getAttribute('aria-hidden'), 'true');
});

test('retry is single flight, stays disabled after acceptance and handles check failure without dispatch', async t => {
  const p = fixture(t); let finish, calls = 0;
  const action = p.w.ChatControls.retry({ host: p.log, label: phase => phase, run: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  action.button.click(); action.button.click(); assert.equal(calls, 1); assert.equal(action.button.disabled, true);
  finish(true); await new Promise(resolve => setImmediate(resolve)); action.refresh();
  action.button.click(); assert.equal(calls, 1); assert.equal(action.button.disabled, true);
  const failed = p.w.ChatControls.retry({ host: p.log, label: phase => phase,
    run: async () => { throw Error('synthetic check failed'); }, onError: () => 'No dispatch' });
  failed.button.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.button.disabled, false); assert.equal(p.log.querySelectorAll('.retry-status')[1].textContent, 'No dispatch');
});
