import { createSseDecoder } from './sse.mjs';

const conversation = document.querySelector('#conversation');
const form = document.querySelector('#composer');
const question = document.querySelector('#question');
const send = document.querySelector('#send');
const stop = document.querySelector('#stop');
const status = document.querySelector('#status');
const webOption = document.querySelector('#web-option');
const webIntent = document.querySelector('#web-intent');
let conversationId = sessionStorage.getItem('providerAExampleConversation') || '';
let controller = null;

function addMessage(role, content = '') {
  const section = document.createElement('section');
  section.className = `message ${role}`;
  const heading = document.createElement('h2');
  heading.textContent = role === 'user' ? '你' : '回答';
  const body = document.createElement('div');
  body.className = 'content';
  body.textContent = content;
  section.append(heading, body);
  conversation.append(section);
  section.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return { section, body };
}

async function loadHistory() {
  if (!conversationId) return;
  const response = await fetch(`/api/conversations/${conversationId}`);
  if (!response.ok) { conversationId = ''; sessionStorage.removeItem('providerAExampleConversation'); return; }
  const detail = await response.json();
  conversation.replaceChildren();
  for (const message of detail.messages || []) {
    const item = addMessage(message.role === 'user' ? 'user' : 'assistant', message.content);
    if (message.role === 'assistant' && Number.isInteger(message.source_count)) {
      const evidence = document.createElement('div');
      evidence.className = 'evidence';
      evidence.textContent = `检索资料 ${message.source_count} 条`;
      item.section.append(evidence);
    }
  }
}

async function readStatus() {
  try {
    const response = await fetch('/api/status');
    const state = await response.json();
    status.textContent = state.synthetic ? '合成模式' : state.ready ? `可用容量 ${state.capacity}` : state.authenticated ? '当前没有原生问答容量' : '待配置或鉴权失败';
    webOption.hidden = !(state.ready && state.webIntentSupported);
    send.disabled = !state.ready;
  } catch { status.textContent = '连接检查失败'; send.disabled = true; }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (controller) return;
  const text = question.value.trim();
  if (!text) return;
  const askedForWeb = webIntent.checked;
  question.value = '';
  webIntent.checked = false;
  addMessage('user', text);
  const answer = addMessage('assistant');
  controller = new AbortController();
  send.hidden = true;
  stop.hidden = false;
  let completed = false;
  let sourceCount = 0;
  try {
    const response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: text, conversationId, requestId: crypto.randomUUID(), sourceIntent: askedForWeb ? 'web' : '' }), signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`请求失败 (${response.status})`);
    const stream = createSseDecoder((type, data) => {
      if (type === 'conversation' && data.conversationId) {
        conversationId = data.conversationId;
        sessionStorage.setItem('providerAExampleConversation', conversationId);
      }
      if (type === 'delta') answer.body.textContent += data.text || '';
      if (type === 'sources') sourceCount = Array.isArray(data.sources) ? data.sources.length : sourceCount;
      if (type === 'error') throw new Error(data.error || '回答失败');
      if (type === 'done') {
        if (completed) throw new Error('重复完成事件');
        completed = true;
        const evidence = document.createElement('div');
        evidence.className = 'evidence';
        const total = Number.isInteger(data.source_count) ? data.source_count : sourceCount;
        evidence.textContent = `检索资料 ${total} 条${askedForWeb && data.web_source_count === 0 ? ' · 未取得可验证网页来源' : ''}`;
        answer.section.append(evidence);
      }
    });
    for await (const chunk of response.body) stream.append(chunk);
    if (!completed) throw new Error('回答中断，未收到完成事件');
  } catch (error) {
    const note = document.createElement('div');
    note.className = 'evidence';
    note.textContent = error.name === 'AbortError' ? '已停止，回答未完成' : String(error.message || '回答未完成');
    answer.section.append(note);
  } finally {
    controller = null;
    send.hidden = false;
    stop.hidden = true;
    question.focus();
  }
});

stop.addEventListener('click', () => controller?.abort());
document.querySelector('#new-conversation').addEventListener('click', () => {
  controller?.abort();
  conversationId = '';
  sessionStorage.removeItem('providerAExampleConversation');
  conversation.replaceChildren();
  question.focus();
});
await readStatus();
await loadHistory();
