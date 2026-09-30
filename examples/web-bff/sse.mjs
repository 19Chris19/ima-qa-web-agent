export function createSseDecoder(onEvent) {
  const decoder = new TextDecoder();
  let pending = '';
  function append(chunk) {
    pending = (pending + decoder.decode(chunk, { stream: true })).replace(/\r\n/gu, '\n');
    if (pending.length > 131072) throw new Error('event_too_large');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const packet = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const event = /^event:\s*([^\s]+)$/mu.exec(packet)?.[1];
      const data = packet.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
  return { append };
}
