export interface SseMessage {event: string; data: string}

export async function* readSse(response: Response): AsyncGenerator<SseMessage> {
  if (!response.body) throw new Error('provider response did not include a stream body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];

  const emit = (): SseMessage | null => {
    if (data.length === 0) {
      event = 'message';
      return null;
    }
    const result = {event, data: data.join('\n')};
    event = 'message';
    data = [];
    return result;
  };

  while (true) {
    const next = await reader.read();
    buffer += decoder.decode(next.value, {stream: !next.done});
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const raw = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (raw === '') {
        const message = emit();
        if (message) yield message;
      } else if (!raw.startsWith(':')) {
        const separator = raw.indexOf(':');
        const field = separator < 0 ? raw : raw.slice(0, separator);
        const value = separator < 0 ? '' : raw.slice(separator + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
    if (next.done) break;
  }
  if (buffer.trim()) data.push(buffer.trim());
  const final = emit();
  if (final) yield final;
}
