import {describe, expect, it} from 'vitest';
import {parseChatMarkdown, plainChatMarkdown} from './chat-markdown.js';

describe('chat markdown', () => {
  it('marks double-asterisk emphasis for neon rendering and removes its delimiters', () => {
    expect(parseChatMarkdown('Hold **AAPL** and **USDG reserves**.')).toEqual([
      {text: 'Hold ', neon: false},
      {text: 'AAPL', neon: true},
      {text: ' and ', neon: false},
      {text: 'USDG reserves', neon: true},
      {text: '.', neon: false},
    ]);
    expect(plainChatMarkdown('Hold **AAPL**.')).toBe('Hold AAPL.');
  });

  it('leaves unmatched asterisks visible', () => {
    expect(plainChatMarkdown('A **still-open thought')).toBe('A **still-open thought');
  });
});