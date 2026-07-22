import {z} from 'zod';

export const holdingSchema = z.object({
  symbol: z.string().min(1).max(12),
  allocationBps: z.number().int().min(0).max(10_000),
  valueUsdg: z.string(),
});

export const chatItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['user', 'agent', 'system', 'tool', 'result', 'external']),
  text: z.string(),
  timestamp: z.string(),
  status: z.enum(['pending', 'success', 'error']).optional(),
});

export const boundarySchema = z.object({
  assetCount: z.number().int().nonnegative(),
  maxTradeUsdg: z.string(),
  dailyCapUsdg: z.string(),
  dailyUsedBps: z.number().int().min(0).max(10_000),
  paused: z.boolean(),
  sessionExpiresAt: z.string().nullable(),
});

export const residentSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  agent: z.object({
    name: z.string().min(1),
    id: z.string().nullable(),
    status: z.enum(['resident', 'sleeping', 'waking', 'read-only', 'stopped']),
    lastWakeAt: z.string().nullable(),
  }),
  network: z.object({
    name: z.string(),
    papernet: z.boolean(),
    connected: z.boolean(),
  }),
  portfolio: z.object({
    equityUsdg: z.string().nullable(),
    epochReturnBps: z.number().int().nullable(),
    holdings: z.array(holdingSchema),
  }),
  boundaries: boundarySchema,
  lastWake: z.object({
    reason: z.enum(['heartbeat', 'human']).nullable(),
    toolCalls: z.number().int().nonnegative(),
    trades: z.number().int().nonnegative(),
    statusPosted: z.boolean(),
  }),
  chat: z.array(chatItemSchema),
  pendingApprovals: z.number().int().nonnegative(),
});

export type ChatItem = z.infer<typeof chatItemSchema>;
export type ResidentSnapshot = z.infer<typeof residentSnapshotSchema>;

export type SessionCommand =
  | {name: 'portfolio'}
  | {name: 'journal'; count: number}
  | {name: 'wake'}
  | {name: 'pause'}
  | {name: 'interrupt'}
  | {name: 'clear'}
  | {name: 'help'}
  | {name: 'quit'};

export type SessionEvent =
  | {type: 'snapshot'; snapshot: ResidentSnapshot}
  | {type: 'chat.append'; item: ChatItem}
  | {type: 'error'; message: string; fix?: string | undefined};
