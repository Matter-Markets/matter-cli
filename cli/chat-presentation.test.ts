import {describe, expect, it} from 'vitest';
import type {ChatItem} from './domain.js';
import {mergeChatItems} from './chat-presentation.js';

describe('mergeChatItems', () => {
  it('places local slash commands in chronological transcript order', () => {
    const resident: ChatItem[] = [
      {id: 'before', kind: 'agent', text: 'before', timestamp: '2026-07-22T14:00:00.000Z'},
      {id: 'after', kind: 'user', text: 'after', timestamp: '2026-07-22T14:00:02.000Z'},
    ];
    const local: ChatItem[] = [
      {id: 'slash', kind: 'user', text: '/portfolio', timestamp: '2026-07-22T14:00:01.000Z'},
    ];

    expect(mergeChatItems(resident, local).map(item => item.id)).toEqual(['before', 'slash', 'after']);
  });

  it('keeps stable ordering and removes duplicate IDs', () => {
    const duplicate: ChatItem = {id: 'same', kind: 'user', text: 'resident copy', timestamp: 'invalid'};
    const local: ChatItem[] = [
      {...duplicate, text: 'local copy'},
      {id: 'next', kind: 'system', text: 'next', timestamp: 'invalid'},
    ];

    expect(mergeChatItems([duplicate], local).map(item => item.text)).toEqual(['resident copy', 'next']);
  });
});
