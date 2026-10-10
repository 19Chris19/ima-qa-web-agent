(function () {
  'use strict';

  const terminal = status => ['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(status);

  function create(requestOptions, { requestTimeoutMs = 15000, streamIdleMs = 45000 } = {}) {
    async function observe(url, options, read) {
      const controller = new AbortController();
      let timer;
      let rejectAbort;
      const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      const abort = () => controller.abort(options.signal.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
      const arm = ms => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new DOMException('任务连接超时，状态尚未确认', 'TimeoutError')), ms);
      };
      arm(requestTimeoutMs);
      if (options.signal?.aborted) abort();
      try {
        return await Promise.race([aborted, (async () => {
          controller.signal.throwIfAborted();
          const response = await fetch(url, requestOptions({
            ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          }));
          controller.signal.throwIfAborted();
          return read(response, { signal: controller.signal, arm });
        })()]);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', rejectAbort);
      }
    }

    async function json(url, options = {}) {
      // Includes body consumption, not just response headers. A timed-out POST
      // has an unknown outcome; callers must recover its requestKey via GET.
      return observe(url, options, async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(data.error || `请求失败 (${response.status})`), { status: response.status });
        return data;
      });
    }

    async function identity() {
      const key = crypto.randomUUID();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
      return { key, requestKey: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
    }

    async function list(filters = {}, signal) {
      const query = new URLSearchParams(filters);
      const data = await json(`/api/tasks?${query}`, { signal });
      return Array.isArray(data.tasks) ? data.tasks : [];
    }

    async function submit(question, conversationId, key) {
      const data = await json('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ question, conversationId }),
      });
      if (!data.task?.id) throw new Error('提交结果未知，请恢复任务');
      return data.task;
    }

    async function legacyAsk(question, conversationId, { signal, onEvent }) {
      const response = await fetch('/api/ask', requestOptions({
        method: 'POST', signal,
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, ...(conversationId ? { conversationId } : {}) }),
      }));
      if (!response.body) throw new Error('浏览器不支持流式响应');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', completed = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = consume(buffer);
          buffer = parsed.remainder;
          for (const event of parsed.events) {
            onEvent(event);
            if (event.event === 'done') completed += 1;
            if (event.event === 'error') throw new Error(event.data.error || '回答未完成');
          }
        }
        if (!response.ok || completed !== 1) throw new Error('连接中断，上游回答未完整结束');
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }

    async function follow(id, { signal, onEvent, onStatus, onReconnect }) {
      let cursor = 0;
      let failures = 0;
      let status = '';
      const receive = event => {
        const sequence = Number(event.id);
        if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('任务事件序号无效');
        if (sequence <= cursor) return;
        if (sequence !== cursor + 1) throw new Error('任务事件序号不连续');
        onEvent(event);
        cursor = sequence;
        if (event.event === 'task.status') {
          status = event.data.status;
          onStatus(status);
        }
      };

      while (!signal.aborted) {
        const before = cursor;
        try {
          const snapshot = await json(`/api/tasks/${encodeURIComponent(id)}`, { signal });
          if (signal.aborted) return null;
          status = snapshot.task.status;
          const expired = snapshot.task.eventsExpired || snapshot.snapshot?.eventsExpired;
          if (expired) {
            if (!terminal(status)) throw new Error('任务事件已过期');
            return { task: snapshot.task, eventsExpired: true };
          }
          for (const event of snapshot.snapshot?.events || []) receive(event);
          status = snapshot.task.status;
          onStatus(status);
          if (terminal(status)) return { task: snapshot.task };

          const result = await observe(`/api/tasks/${encodeURIComponent(id)}/events?after=${cursor}`, {
            signal, headers: { Accept: 'text/event-stream' },
          }, async (response, observer) => {
            if (!response.ok) throw Object.assign(new Error(`订阅失败 (${response.status})`), { status: response.status });
            if (!response.body) throw new Error('浏览器不支持流式响应');
            observer.arm(streamIdleMs);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const abort = () => { void reader.cancel().catch(() => {}); };
            observer.signal.addEventListener('abort', abort, { once: true });
            try {
              while (!observer.signal.aborted) {
                const { value, done } = await reader.read();
                if (observer.signal.aborted || done) break;
                // Heartbeats and partial frames count as transport activity.
                if (value.byteLength) observer.arm(streamIdleMs);
                buffer += decoder.decode(value, { stream: true });
                const parsed = consume(buffer);
                buffer = parsed.remainder;
                for (const event of parsed.events) receive(event);
                if (terminal(status)) return { task: { id, status } };
              }
            } finally {
              observer.signal.removeEventListener('abort', abort);
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          });
          if (result) return result;
          if (signal.aborted) return null;
        } catch (error) {
          if (signal.aborted) return null;
          if ([401, 403, 404].includes(error.status)) throw error;
        }
        // Rotation/EOF is only a subscription loss, never a task failure or re-submit.
        failures = cursor > before ? 0 : failures + 1;
        if (failures > 5) throw new Error('连接暂不可用，任务状态尚未确认');
        onReconnect();
        await delay(Math.min(500 * 2 ** failures, 8000), signal);
      }
      return null;
    }

    return {
      identity, list, submit, follow, legacyAsk,
      capabilities: () => json('/api/capabilities'),
      cancel: id => json(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    };
  }

  function delay(ms, signal) {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  function consume(buffer) {
    const events = [];
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const lines = block.split(/\r?\n/);
      const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
      if (!name) continue;
      const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim();
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      events.push({ id, event: name, data: JSON.parse(data) });
    }
    return { events, remainder: buffer };
  }

  window.ProviderQaTasks = { create, terminal };
})();
