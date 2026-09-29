'use strict';

const CONTEXT_REF = '@context-ref?id=';
const COMPLETE_CONTEXT_REF = /\s*[(（]@context-ref\?id=\d{1,6}[)）]\s*$/iu;

function sanitizeIMAAnswerText(answer) {
  return String(answer || '').replace(COMPLETE_CONTEXT_REF, '');
}

function createAnswerTextStream() {
  let pending = '';

  return {
    push(chunk) {
      pending += String(chunk || '');
      const candidate = contextRefTailStart(pending);
      if (candidate >= 0) {
        const stable = pending.slice(0, candidate);
        pending = pending.slice(candidate);
        return stable;
      }
      const trailingWhitespace = /\s*$/u.exec(pending)[0].length;
      const stable = pending.slice(0, pending.length - trailingWhitespace);
      pending = pending.slice(pending.length - trailingWhitespace);
      return stable;
    },
    finish() {
      const stable = sanitizeIMAAnswerText(pending);
      pending = '';
      return stable;
    },
  };
}

function contextRefTailStart(text) {
  for (let index = text.length - 1; index >= Math.max(0, text.length - 40); index -= 1) {
    if (text[index] !== '(' && text[index] !== '（') continue;
    const remainder = text.slice(index + 1);
    const partialPrefix = CONTEXT_REF.startsWith(remainder);
    const partialSuffix = remainder.startsWith(CONTEXT_REF)
      && /^\d{0,6}[)）]?\s*$/u.test(remainder.slice(CONTEXT_REF.length));
    if (!partialPrefix && !partialSuffix) continue;
    let start = index;
    while (start > 0 && /\s/u.test(text[start - 1])) start -= 1;
    return start;
  }
  return -1;
}

module.exports = { createAnswerTextStream, sanitizeIMAAnswerText };
