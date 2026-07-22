export interface ChatMarkdownSegment {
  text: string;
  neon: boolean;
}

const STRONG = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;

export function parseChatMarkdown(value: string): ChatMarkdownSegment[] {
  const segments: ChatMarkdownSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(STRONG)) {
    const index = match.index;
    if (index > cursor) segments.push({text: value.slice(cursor, index), neon: false});
    segments.push({text: match[1] ?? '', neon: true});
    cursor = index + match[0].length;
  }
  if (cursor < value.length) segments.push({text: value.slice(cursor), neon: false});
  return segments.length > 0 ? segments : [{text: value, neon: false}];
}

export function plainChatMarkdown(value: string): string {
  return parseChatMarkdown(value).map(segment => segment.text).join('');
}