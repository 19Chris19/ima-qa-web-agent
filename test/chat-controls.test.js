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


function messageFixture(t) {
  const p = fixture(t), doc = p.w.document;
  const message = doc.createElement('article'), text = doc.createElement('div');
  text.textContent = 'Synthetic sent question'; message.append(text); p.log.append(message);
  const timers = new Map(); let sequence = 0;
  p.w.setTimeout = fn => { timers.set(++sequence, fn); return sequence; };
  p.w.clearTimeout = id => timers.delete(id);
  p.w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  p.w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const sent = p.w.ChatControls.messageActions({ message, target: text, getText: () => text.textContent });
  const pointer = (type, fields = {}) => {
    const event = new p.w.MouseEvent(type, { bubbles: true, clientX: fields.x ?? 20, clientY: fields.y ?? 20 });
    Object.defineProperties(event, { pointerType: { value: 'touch' }, pointerId: { value: fields.id ?? 1 }, isPrimary: { value: fields.primary ?? true } });
    text.dispatchEvent(event);
  };
  return { ...p, doc, message, text, sent, pointer, hold() { for (const fn of [...timers.values()]) fn(); timers.clear(); },
    menu: () => doc.querySelector('.message-action-dialog[open]') };
}

test('retry toolbar is icon-only with an accessible label and shares its single-flight guard with the message menu', async t => {
  const p = messageFixture(t); let calls = 0, finish;
  const retry = p.w.ChatControls.retry({ host: p.log, label: () => '重试', run: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(retry.button.querySelector('span').className, 'chat-control-label');
  assert.equal(retry.button.getAttribute('aria-label'), '重试');
  p.sent.setAction(retry); p.sent.button.click();
  p.menu().querySelector('[data-action="retry"]').click(); retry.button.click(); void retry.invoke();
  assert.equal(calls, 1); assert.equal(p.menu(), null);
  finish(true); await new Promise(resolve => setImmediate(resolve));
  p.sent.button.click(); assert.equal(p.menu().querySelector('[data-action="retry"]').disabled, true);
});

test('touch hold survives its release click; moving, scrolling, selection and multitouch cancel it', t => {
  const p = messageFixture(t);
  for (const cancel of [() => p.pointer('pointermove', { y: 32 }),
    () => p.log.dispatchEvent(new p.w.Event('scroll')),
    () => p.pointer('pointercancel'), () => p.pointer('pointerdown', { id: 2, primary: false })]) {
    p.pointer('pointerdown'); cancel(); p.hold(); assert.equal(p.menu(), null);
  }
  const range = p.doc.createRange(); range.selectNodeContents(p.text); p.w.getSelection().removeAllRanges(); p.w.getSelection().addRange(range);
  p.pointer('pointerdown'); p.hold(); assert.equal(p.menu(), null);
  p.w.getSelection().removeAllRanges();
  p.pointer('pointerdown'); p.doc.dispatchEvent(new p.w.Event('selectionchange')); p.hold();
  assert.ok(p.menu(), 'a collapsed selectionchange must not cancel a real hold');
  const dialog = p.menu(); dialog.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(p.menu(), dialog, 'the touch release must not dismiss the newly opened panel');
  dialog.click(); assert.equal(p.menu(), null, 'a later intentional backdrop tap dismisses');
  p.pointer('pointerdown'); p.hold();
  const next = p.menu(); next.dispatchEvent(new p.w.MouseEvent('pointerdown', { bubbles: true })); next.click();
  assert.equal(p.menu(), null, 'a fresh backdrop press dismisses even if the hold emitted no compatibility click');
});

test('menu restores focus, traps keyboard focus, keeps selected text native, and closes on navigation', async t => {
  const p = messageFixture(t);
  p.sent.button.click(); const dialog = p.menu();
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  dialog.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(p.doc.activeElement, dialog.querySelector('.message-action-close'));
  dialog.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(p.menu(), null); assert.equal(p.doc.activeElement, p.sent.button);
  const range = p.doc.createRange(); range.selectNodeContents(p.text); p.w.getSelection().removeAllRanges(); p.w.getSelection().addRange(range);
  const context = new p.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }); p.text.dispatchEvent(context);
  assert.equal(context.defaultPrevented, false); assert.equal(p.menu(), null);
  p.w.getSelection().removeAllRanges(); p.sent.button.click();
  p.message.remove(); await new Promise(resolve => setImmediate(resolve)); assert.equal(p.menu(), null);
});

test('copying a sent question falls back to selectable text without losing its actions', async t => {
  const p = messageFixture(t);
  Object.defineProperty(p.w.navigator, 'clipboard', { value: { writeText: async () => { throw Error('synthetic denied'); } } });
  p.sent.button.click(); p.menu().querySelector('[data-action="copy"]').click();
  await new Promise(resolve => setImmediate(resolve));
  const field = p.menu().querySelector('textarea');
  assert.equal(field.value, p.text.textContent); assert.equal(field.readOnly, true); assert.equal(p.doc.activeElement, field);
  assert.equal(field.selectionStart, 0); assert.equal(field.selectionEnd, field.value.length);
});

test('failure display distinguishes no answer, partial text, cancellation and unknown outcomes without raw errors', t => {
  const p = fixture(t);
  for (const [status, hasAnswer, expected] of [['failed', false, /暂时未能回答/], ['failed', true, /已保留收到/], ['cancelled', true, /已停止/], ['indeterminate', false, /先检查原任务/]]) {
    const note = p.w.ChatControls.failure(p.log, { status, hasAnswer });
    assert.match(note.textContent, expected); assert.equal(note.dataset.outcome, status);
    assert.equal(p.log.querySelectorAll('.answer-outcome').length, 1);
    assert.equal(note.getAttribute('role'), 'status');
  }
});
