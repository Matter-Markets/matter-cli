import {z} from 'zod';

export const adapterKindSchema = z.enum(['openai-responses', 'anthropic', 'openai-compatible', 'gemini']);
export type AdapterKind = z.infer<typeof adapterKindSchema>;

export const modelConfigSchema = z.object({
  adapter: adapterKindSchema,
  model: z.string().min(1),
  base_url: z.string().url().optional(),
  key_ref: z.string().min(1).optional(),
  max_output_tokens: z.number().int().min(64).max(131_072).default(4_096),
  max_turns_per_wake: z.number().int().min(1).max(32).default(8),
  max_tool_calls_per_wake: z.number().int().min(1).max(64).default(16),
  request_timeout_ms: z.number().int().min(1_000).max(600_000).default(120_000),
  heartbeat_minutes: z.number().int().min(0).max(10_080).default(30),
  daily_model_budget_usd: z.number().min(0).max(10_000).default(5),
  input_usd_per_million: z.number().min(0).max(10_000).optional(),
  output_usd_per_million: z.number().min(0).max(10_000).optional(),
}).superRefine((value, context) => {
  if (value.daily_model_budget_usd > 0 && (value.input_usd_per_million === undefined || value.output_usd_per_million === undefined)) {
    context.addIssue({code: 'custom', message: 'input and output pricing are required when the daily model budget is enabled'});
  }
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

export type ModelRole = 'user' | 'assistant';

export interface TextBlock {type: 'text'; text: string}
export interface ToolCallBlock {type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown>}
export interface ToolResultBlock {type: 'tool_result'; toolCallId: string; name: string; content: string; isError: boolean}
export type ModelBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface ModelMessage {
  role: ModelRole;
  blocks: ModelBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutating: boolean;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export type ModelEvent =
  | {type: 'text_delta'; text: string}
  | {type: 'tool_call'; call: ToolCallBlock}
  | {type: 'usage'; inputTokens: number; outputTokens: number}
  | {type: 'stop'; reason: string};

export interface ModelTurnResult {
  text: string;
  toolCalls: ToolCallBlock[];
  usage: {inputTokens: number; outputTokens: number} | null;
  stopReason: string;
}

export interface ModelAdapter {
  readonly kind: AdapterKind;
  run(request: ModelRequest, onEvent?: (event: ModelEvent) => void): Promise<ModelTurnResult>;
}

export interface CredentialStore {
  get(reference: string): Promise<string | null>;
  put(reference: string, secret: string): Promise<void>;
  delete(reference: string): Promise<void>;
}
