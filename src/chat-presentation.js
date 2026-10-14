'use strict';

// An optional public view. Raw operational records remain available to existing
// internal consumers; never derive a citation from a source's array position.
const PHASES = Object.freeze({ knowledge: '资料检索', web: '联网搜索', answer: '回答生成' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').trim().slice(0, max) : '';
const validKey = key => /^(index|context|ref|para):[^\s?&#]{1,128}$/u.test(key);

function webUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || /(^|\.)ima\.qq\.com$/iu.test(url.hostname)
      || [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()]
        .some(key => /token|cookie|credential|secret|password|authorization|api[_-]?key|signature/iu.test(key))) return '';
    return url.href;
  } catch { return ''; }
}

function citationMap(value) {
  const result = {};
  if (!object(value)) return result;
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (!validKey(key) || !object(entry)) continue;
    const type = ['knowledge', 'web', 'unknown'].includes(entry.type) ? entry.type : 'unknown';
    result[key] = { type, ...(type === 'unknown' && entry.conflicted === true ? { conflicted: true } : {}) };
    if (Array.isArray(entry.displayNumbers)) result[key].displayNumbers = [...new Set(entry.displayNumbers
      .filter(n => typeof n === 'string' && /^\d{1,6}$/u.test(n)))].slice(0, 100);
    if (type === 'web') {
      result[key].sources = (Array.isArray(entry.sources) ? entry.sources : []).slice(0, 10)
        .flatMap(source => {
          const url = webUrl(source?.url);
          return url ? [{ url, title: text(source.title, 512), snippet: text(source.snippet, 5000) }] : [];
        });
    }
  }
  return result;
}

function mergeCitations(previous, incoming) {
  const result = citationMap(previous);
  for (const [key, entry] of Object.entries(citationMap(incoming))) {
    const old = result[key];
    if (old?.conflicted) continue;
    // Conflicting provenance cannot authorize a web card.
    if (old && old.type !== entry.type && old.type !== 'unknown' && entry.type !== 'unknown') {
      result[key] = { type: 'unknown', conflicted: true }; continue;
    }
    if (entry.type === 'unknown' && old) continue;
    const sources = new Map((old?.sources || []).map(source => [source.url, source]));
    for (const source of entry.sources || []) {
      const before = sources.get(source.url) || {};
      sources.set(source.url, { url: source.url, title: source.title || before.title || '',
        snippet: source.snippet || before.snippet || '' });
    }
    result[key] = { ...entry,
      ...(entry.type === 'web' ? { sources: [...sources.values()].slice(0, 10) } : {}),
      displayNumbers: [...new Set([...(old?.displayNumbers || []), ...(entry.displayNumbers || [])])] };
  }
  return result;
}

function suggestions(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value.slice(0, 100)) {
    // IMA SUGGEST_QUESTION carries objects with text/Text. Discard all tool and
    // knowledge-base metadata, including when text is absent or invalid.
    const raw = typeof item === 'string' ? item : item?.text ?? item?.Text;
    if (typeof raw !== 'string' || raw.length > 2000) continue;
    const question = text(raw, 2000);
    if (question && !result.includes(question)) result.push(question);
    if (result.length === 3) break;
  }
  return result;
}

function processStep(value) {
  if (!object(value) || !Object.hasOwn(PHASES, value.phase)
    || !['running', 'completed', 'failed', 'cancelled'].includes(value.status)) return null;
  return { stepId: `chat:${value.phase}`, phase: value.phase, status: value.status, label: PHASES[value.phase] };
}

function metadata(value = {}) {
  return { ...(Object.hasOwn(value, 'citationMap') ? { citationMap: citationMap(value.citationMap) } : {}),
    ...(Object.hasOwn(value, 'suggestions') ? { suggestions: suggestions(value.suggestions) } : {}),
    ...(Object.hasOwn(value, 'process') ? { process: (Array.isArray(value.process) ? value.process : [])
      .map(processStep).filter(Boolean).slice(-40) } : {}) };
}

function withDisplayNumbers(map, answer) {
  const result = citationMap(map);
  // Association is explicit in the Markdown target, not its display label.
  const visible = String(answer || '')
    .replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/gu, ' ')
    .replace(/(`+)[\s\S]*?\1/gu, ' ')
    .replace(/(?<!\\)(\${1,2})[\s\S]*?(?<!\\)\1/gu, ' ');
  for (const match of visible.matchAll(/\[([\d,]+)\]\(@(context|index)-ref\?id=([^\s)&#]+)(?:[^)]*)\)/gu)) {
    let id;
    try { id = decodeURIComponent(match[3]); } catch { continue; }
    const entry = result[`${match[2]}:${id}`];
    if (entry) entry.displayNumbers = [...new Set([...(entry.displayNumbers || []), ...match[1].split(',')])];
  }
  return result;
}

function projectData(name, data = {}) {
  if (name === 'sources') return { citationMap: citationMap(data.citationMap),
    sourceCount: Number.isSafeInteger(data.sources?.length) ? data.sources.length : Number(data.sourceCount) || 0 };
  if (name === 'process') return processStep(data) || {};
  if (name === 'suggestions') return { suggestions: suggestions(data.suggestions) };
  if (name === 'done') {
    const { searchSummary, sources, ...rest } = data;
    const result = {};
    for (const key of ['conversationId', 'requestId', 'source_intent', 'answer_basis', 'source_count',
      'knowledge_source_count', 'web_source_count', 'sourceIntent', 'answerBasis', 'sourceCount',
      'knowledgeSourceCount', 'webSourceCount', 'complete', 'interrupted']) {
      if (Object.hasOwn(rest, key)) result[key] = rest[key];
    }
    if (object(rest.timing)) result.timing = { elapsed_ms: Number(rest.timing.elapsed_ms) || 0, queue_wait_ms: Number(rest.timing.queue_wait_ms) || 0 };
    return { ...result, ...metadata(rest) };
  }
  return data;
}

function projectSnapshot(value) {
  return { ...value, snapshot: value.snapshot ? { ...value.snapshot,
    events: (value.snapshot.events || []).map(event => ({ ...event, data: projectData(event.event, event.data) })) } : value.snapshot };
}

function projectHistory(value) {
  return { ...value, messages: (value.messages || []).map(message => {
    if (message.role !== 'assistant') return message;
    const { sources, searchSummary, ...rest } = message;
    return { ...rest, ...metadata(message), sourceCount: sources?.length || message.sourceCount || 0 };
  }) };
}

module.exports = { PHASES, webUrl, citationMap, mergeCitations, suggestions, processStep, metadata,
  withDisplayNumbers, projectData, projectSnapshot, projectHistory };
