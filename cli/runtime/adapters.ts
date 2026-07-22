import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {SecretRedactor} from './redaction.js';
import {readSse} from './sse.js';
import type {
  CredentialStore,
  ModelAdapter,
  ModelBlock,
  ModelConfig,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelTurnResult,
  ToolCallBlock,
} from './types.js';

const objectSchema = z.record(z.string(), z.unknown());

function strictToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties as Record<string, unknown> : {};
  return {...schema, required: Object.keys(properties), additionalProperties: false};
}

async function boundedResponseText(response: Response, maxBytes = 65_536): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel('provider error body exceeds size limit'); throw new Error('provider error body exceeds size limit'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total).toString('utf8');
}

function baseUrl(config: ModelConfig): string {
  const defaults = {
    'openai-responses': 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    'openai-compatible': 'https://api.openai.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
  } as const;
  return (config.base_url ?? defaults[config.adapter]).replace(/\/$/, '');
}

function parseArguments(value: string, provider: string): Record<string, unknown> {
  try { return objectSchema.parse(JSON.parse(value || '{}')); }
  catch { throw new Error(`${provider} returned invalid tool arguments`); }
}

async function providerFetch(url: string, init: RequestInit, timeoutMs: number, signal: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const controlled = AbortSignal.any([signal, timeout]);
  try {
    const response = await fetch(url, {...init, signal: controlled});
    if (!response.ok) {
      const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
      let detail = '';
      if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        try {
          const value = objectSchema.parse(JSON.parse(await boundedResponseText(response)));
          const error = value.error && typeof value.error === 'object' ? objectSchema.parse(value.error) : {};
          const message = typeof error.message === 'string' ? error.message : typeof value.message === 'string' ? value.message : '';
          const requestHeaders = new Headers(init.headers); const authorization = requestHeaders.get('authorization');
          detail = new SecretRedactor([authorization, authorization?.replace(/^Bearer\s+/i, ''), requestHeaders.get('x-api-key')]).text(message).slice(0, 500);
        } catch { await response.body?.cancel().catch(() => undefined); }
      } else await response.body?.cancel().catch(() => undefined);
      throw new Error(`model provider returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}${detail ? `: ${detail}` : ''}`);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('text/event-stream')) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`model provider returned unsupported content type ${contentType || 'unknown'} for a streaming request`);
    }
    return response;
  } catch (error) {
    if (controlled.aborted) throw controlled.reason instanceof Error ? controlled.reason : new Error('model request aborted');
    throw error;
  }
}

function emit(onEvent: ((event: ModelEvent) => void) | undefined, event: ModelEvent): void {
  onEvent?.(event);
}

function finish(text: string, toolCalls: ToolCallBlock[], usage: ModelTurnResult['usage'], stopReason: string, onEvent?: (event: ModelEvent) => void): ModelTurnResult {
  if (usage) emit(onEvent, {type: 'usage', ...usage});
  emit(onEvent, {type: 'stop', reason: stopReason});
  return {text, toolCalls, usage, stopReason};
}

function authHeaders(secret: string | null): Record<string, string> {
  return secret ? {authorization: `Bearer ${secret}`} : {};
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  readonly kind = 'openai-responses' as const;
  constructor(readonly config: ModelConfig, readonly secret: string | null) {}

  async run(request: ModelRequest, onEvent?: (event: ModelEvent) => void): Promise<ModelTurnResult> {
    const input: unknown[] = [];
    for (const message of request.messages) {
      const text = message.blocks.filter((block): block is Extract<ModelBlock, {type: 'text'}> => block.type === 'text').map(block => block.text).join('');
      if (text) input.push({role: message.role, content: [{type: message.role === 'assistant' ? 'output_text' : 'input_text', text}]});
      for (const block of message.blocks) {
        if (block.type === 'tool_call') input.push({type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.arguments)});
        if (block.type === 'tool_result') input.push({type: 'function_call_output', call_id: block.toolCallId, output: block.content});
      }
    }
    const response = await providerFetch(`${baseUrl(this.config)}/responses`, {
      method: 'POST',
      headers: {'content-type': 'application/json', ...authHeaders(this.secret)},
      body: JSON.stringify({
        model: this.config.model,
        instructions: request.system,
        input,
        tools: request.tools.map(tool => ({type: 'function', name: tool.name, description: tool.description, parameters: strictToolSchema(tool.inputSchema), strict: true})),
        max_output_tokens: request.maxOutputTokens,
        stream: true,
        store: false,
      }),
    }, this.config.request_timeout_ms, request.signal);

    let text = '';
    let usage: ModelTurnResult['usage'] = null;
    let stopReason = 'completed';
    const calls = new Map<number, {id: string; name: string; arguments: string}>();
    for await (const message of readSse(response)) {
      if (message.data === '[DONE]') break;
      const data = objectSchema.parse(JSON.parse(message.data));
      const type = String(data.type ?? message.event);
      if (type === 'response.output_text.delta') {
        const delta = String(data.delta ?? ''); text += delta; emit(onEvent, {type: 'text_delta', text: delta});
      } else if (type === 'response.output_item.added') {
        const item = objectSchema.parse(data.item);
        if (item.type === 'function_call') calls.set(Number(data.output_index ?? calls.size), {id: String(item.call_id ?? item.id), name: String(item.name), arguments: String(item.arguments ?? '')});
      } else if (type === 'response.function_call_arguments.delta') {
        const index = Number(data.output_index ?? 0);
        const call = calls.get(index);
        if (call) call.arguments += String(data.delta ?? '');
      } else if (type === 'response.output_item.done') {
        const item = objectSchema.parse(data.item);
        if (item.type === 'function_call') calls.set(Number(data.output_index ?? calls.size), {id: String(item.call_id ?? item.id), name: String(item.name), arguments: String(item.arguments ?? '')});
      } else if (type === 'response.completed') {
        const completed = objectSchema.parse(data.response);
        const rawUsage = completed.usage ? objectSchema.parse(completed.usage) : null;
        if (rawUsage) usage = {inputTokens: Number(rawUsage.input_tokens ?? 0), outputTokens: Number(rawUsage.output_tokens ?? 0)};
        stopReason = String(completed.status ?? 'completed');
      } else if (type === 'response.failed' || type === 'error') {
        throw new Error('OpenAI Responses request failed');
      }
    }
    const toolCalls = [...calls.values()].map(call => ({type: 'tool_call' as const, id: call.id, name: call.name, arguments: parseArguments(call.arguments, 'OpenAI')}));
    for (const call of toolCalls) emit(onEvent, {type: 'tool_call', call});
    return finish(text, toolCalls, usage, stopReason, onEvent);
  }
}

function chatMessages(system: string, messages: ModelMessage[]): unknown[] {
  const output: unknown[] = [{role: 'system', content: system}];
  for (const message of messages) {
    const text = message.blocks.filter((block): block is Extract<ModelBlock, {type: 'text'}> => block.type === 'text').map(block => block.text).join('');
    const toolCalls = message.blocks.filter((block): block is ToolCallBlock => block.type === 'tool_call');
    if (message.role === 'assistant') output.push({role: 'assistant', content: text || null, ...(toolCalls.length ? {tool_calls: toolCalls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))} : {})});
    else {
      if (text) output.push({role: 'user', content: text});
      for (const block of message.blocks) if (block.type === 'tool_result') output.push({role: 'tool', tool_call_id: block.toolCallId, content: block.content});
    }
  }
  return output;
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly kind = 'openai-compatible' as const;
  constructor(readonly config: ModelConfig, readonly secret: string | null) {}

  async run(request: ModelRequest, onEvent?: (event: ModelEvent) => void): Promise<ModelTurnResult> {
    const response = await providerFetch(`${baseUrl(this.config)}/chat/completions`, {
      method: 'POST', headers: {'content-type': 'application/json', ...authHeaders(this.secret)},
      body: JSON.stringify({
        model: this.config.model, messages: chatMessages(request.system, request.messages), stream: true, stream_options: {include_usage: true},
        max_tokens: request.maxOutputTokens,
        tools: request.tools.map(tool => ({type: 'function', function: {name: tool.name, description: tool.description, parameters: strictToolSchema(tool.inputSchema), strict: true}})),
      }),
    }, this.config.request_timeout_ms, request.signal);
    let text = '';
    let usage: ModelTurnResult['usage'] = null;
    let stopReason = 'stop';
    const calls = new Map<number, {id: string; name: string; arguments: string}>();
    for await (const message of readSse(response)) {
      if (message.data === '[DONE]') break;
      const data = objectSchema.parse(JSON.parse(message.data));
      if (data.usage) {
        const raw = objectSchema.parse(data.usage);
        usage = {inputTokens: Number(raw.prompt_tokens ?? 0), outputTokens: Number(raw.completion_tokens ?? 0)};
      }
      const choices = Array.isArray(data.choices) ? data.choices : [];
      const choice = choices[0] ? objectSchema.parse(choices[0]) : null;
      if (!choice) continue;
      if (choice.finish_reason) stopReason = String(choice.finish_reason);
      const delta = choice.delta ? objectSchema.parse(choice.delta) : {};
      if (typeof delta.content === 'string') { text += delta.content; emit(onEvent, {type: 'text_delta', text: delta.content}); }
      if (Array.isArray(delta.tool_calls)) for (const rawCall of delta.tool_calls) {
        const value = objectSchema.parse(rawCall); const index = Number(value.index ?? 0);
        const fn = value.function ? objectSchema.parse(value.function) : {};
        const current = calls.get(index) ?? {id: '', name: '', arguments: ''};
        if (value.id) current.id = String(value.id);
        if (fn.name) current.name += String(fn.name);
        if (fn.arguments) current.arguments += String(fn.arguments);
        calls.set(index, current);
      }
    }
    const toolCalls = [...calls.values()].map(call => ({type: 'tool_call' as const, id: call.id || randomUUID(), name: call.name, arguments: parseArguments(call.arguments, 'OpenAI-compatible provider')}));
    for (const call of toolCalls) emit(onEvent, {type: 'tool_call', call});
    return finish(text, toolCalls, usage, stopReason, onEvent);
  }
}

function anthropicMessages(messages: ModelMessage[]): unknown[] {
  return messages.map(message => ({
    role: message.role,
    content: message.blocks.map(block => {
      if (block.type === 'text') return {type: 'text', text: block.text};
      if (block.type === 'tool_call') return {type: 'tool_use', id: block.id, name: block.name, input: block.arguments};
      return {type: 'tool_result', tool_use_id: block.toolCallId, content: block.content, is_error: block.isError};
    }),
  }));
}

export class AnthropicAdapter implements ModelAdapter {
  readonly kind = 'anthropic' as const;
  constructor(readonly config: ModelConfig, readonly secret: string | null) {}

  async run(request: ModelRequest, onEvent?: (event: ModelEvent) => void): Promise<ModelTurnResult> {
    if (!this.secret) throw new Error('Anthropic credential is required');
    const response = await providerFetch(`${baseUrl(this.config)}/messages`, {
      method: 'POST', headers: {'content-type': 'application/json', 'x-api-key': this.secret, 'anthropic-version': '2023-06-01'},
      body: JSON.stringify({model: this.config.model, system: request.system, messages: anthropicMessages(request.messages), max_tokens: request.maxOutputTokens, stream: true,
        tools: request.tools.map(tool => ({name: tool.name, description: tool.description, input_schema: tool.inputSchema, strict: true}))}),
    }, this.config.request_timeout_ms, request.signal);
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = 'end_turn';
    const calls = new Map<number, {id: string; name: string; arguments: string}>();
    for await (const message of readSse(response)) {
      const data = objectSchema.parse(JSON.parse(message.data));
      const type = String(data.type ?? message.event);
      if (type === 'message_start') {
        const rawMessage = objectSchema.parse(data.message); const rawUsage = objectSchema.parse(rawMessage.usage ?? {}); inputTokens = Number(rawUsage.input_tokens ?? 0);
      } else if (type === 'content_block_start') {
        const block = objectSchema.parse(data.content_block);
        if (block.type === 'tool_use') calls.set(Number(data.index), {id: String(block.id), name: String(block.name), arguments: JSON.stringify(block.input ?? {}).replace(/^\{\}$/, '')});
      } else if (type === 'content_block_delta') {
        const delta = objectSchema.parse(data.delta);
        if (delta.type === 'text_delta') { const value = String(delta.text ?? ''); text += value; emit(onEvent, {type: 'text_delta', text: value}); }
        if (delta.type === 'input_json_delta') { const call = calls.get(Number(data.index)); if (call) call.arguments += String(delta.partial_json ?? ''); }
      } else if (type === 'message_delta') {
        const delta = objectSchema.parse(data.delta ?? {}); if (delta.stop_reason) stopReason = String(delta.stop_reason);
        const rawUsage = objectSchema.parse(data.usage ?? {}); outputTokens = Number(rawUsage.output_tokens ?? outputTokens);
      } else if (type === 'error') throw new Error('Anthropic request failed');
    }
    const toolCalls = [...calls.values()].map(call => ({type: 'tool_call' as const, id: call.id, name: call.name, arguments: parseArguments(call.arguments || '{}', 'Anthropic')}));
    for (const call of toolCalls) emit(onEvent, {type: 'tool_call', call});
    return finish(text, toolCalls, {inputTokens, outputTokens}, stopReason, onEvent);
  }
}

function geminiContents(messages: ModelMessage[]): unknown[] {
  return messages.map(message => ({role: message.role === 'assistant' ? 'model' : 'user', parts: message.blocks.map(block => {
    if (block.type === 'text') return {text: block.text};
    if (block.type === 'tool_call') return {functionCall: {name: block.name, args: block.arguments}};
    return {functionResponse: {name: block.name, response: {content: block.content, is_error: block.isError}}};
  })}));
}

export class GeminiAdapter implements ModelAdapter {
  readonly kind = 'gemini' as const;
  constructor(readonly config: ModelConfig, readonly secret: string | null) {}

  async run(request: ModelRequest, onEvent?: (event: ModelEvent) => void): Promise<ModelTurnResult> {
    if (!this.secret) throw new Error('Gemini credential is required');
    const endpoint = `${baseUrl(this.config)}/models/${encodeURIComponent(this.config.model)}:streamGenerateContent?alt=sse`;
    const response = await providerFetch(endpoint, {
      method: 'POST', headers: {'content-type': 'application/json', 'x-goog-api-key': this.secret},
      body: JSON.stringify({systemInstruction: {parts: [{text: request.system}]}, contents: geminiContents(request.messages),
        tools: [{functionDeclarations: request.tools.map(tool => ({name: tool.name, description: tool.description, parameters: tool.inputSchema}))}],
        generationConfig: {maxOutputTokens: request.maxOutputTokens}}),
    }, this.config.request_timeout_ms, request.signal);
    let text = '';
    let usage: ModelTurnResult['usage'] = null;
    let stopReason = 'STOP';
    const toolCalls: ToolCallBlock[] = [];
    for await (const message of readSse(response)) {
      const data = objectSchema.parse(JSON.parse(message.data));
      if (data.usageMetadata) {
        const raw = objectSchema.parse(data.usageMetadata);
        usage = {inputTokens: Number(raw.promptTokenCount ?? 0), outputTokens: Number(raw.candidatesTokenCount ?? 0)};
      }
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      for (const rawCandidate of candidates) {
        const candidate = objectSchema.parse(rawCandidate); if (candidate.finishReason) stopReason = String(candidate.finishReason);
        const content = candidate.content ? objectSchema.parse(candidate.content) : {}; const parts = Array.isArray(content.parts) ? content.parts : [];
        for (const rawPart of parts) {
          const part = objectSchema.parse(rawPart);
          if (typeof part.text === 'string') { text += part.text; emit(onEvent, {type: 'text_delta', text: part.text}); }
          if (part.functionCall) {
            const call = objectSchema.parse(part.functionCall);
            toolCalls.push({type: 'tool_call', id: `gemini-${randomUUID()}`, name: String(call.name), arguments: objectSchema.parse(call.args ?? {})});
          }
        }
      }
    }
    for (const call of toolCalls) emit(onEvent, {type: 'tool_call', call});
    return finish(text, toolCalls, usage, stopReason, onEvent);
  }
}

export async function createModelAdapter(config: ModelConfig, credentials: CredentialStore): Promise<{adapter: ModelAdapter; secret: string | null}> {
  const secret = config.key_ref ? await credentials.get(config.key_ref) : null;
  if (config.key_ref && !secret) throw new Error(`model credential ${config.key_ref} is unavailable`);
  if (config.adapter === 'openai-responses') return {adapter: new OpenAIResponsesAdapter(config, secret), secret};
  if (config.adapter === 'anthropic') return {adapter: new AnthropicAdapter(config, secret), secret};
  if (config.adapter === 'gemini') return {adapter: new GeminiAdapter(config, secret), secret};
  return {adapter: new OpenAICompatibleAdapter(config, secret), secret};
}
