class MIMOClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required');
    }

    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = fetchImpl;
  }

  async *streamAnswer(messages, options = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.2,
        max_tokens: 1600,
        stream: true,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MIMO API returned HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    yield* parseOpenAICompatibleStream(response);
  }
}

async function* parseOpenAICompatibleStream(response) {
  if (!response.body) {
    throw new Error('MIMO API did not return a readable stream');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary = findSseBoundary(buffer);
    while (boundary) {
      const eventBlock = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);

      const delta = parseStreamEvent(eventBlock);
      if (delta.done) {
        return;
      }
      if (delta.text) {
        yield delta.text;
      }

      boundary = findSseBoundary(buffer);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const delta = parseStreamEvent(buffer);
    if (!delta.done && delta.text) {
      yield delta.text;
    }
  }
}

function findSseBoundary(buffer) {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseStreamEvent(eventBlock) {
  const data = eventBlock
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');

  if (!data || data === '[DONE]') {
    return { done: true, text: '' };
  }

  const payload = JSON.parse(data);
  return { done: false, text: payload.choices?.[0]?.delta?.content || '' };
}

module.exports = {
  findSseBoundary,
  MIMOClient,
  parseOpenAICompatibleStream,
  parseStreamEvent,
};
