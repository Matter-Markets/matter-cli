import {afterEach, describe, expect, it, vi} from 'vitest';
import {AnthropicAdapter, GeminiAdapter, OpenAICompatibleAdapter, OpenAIResponsesAdapter} from './adapters.js';
import {MATTER_TOOLS} from './harness-tools.js';
import {modelConfigSchema, type AdapterKind, type ModelRequest} from './types.js';

function config(adapter: AdapterKind) {
  return modelConfigSchema.parse({adapter, model: 'frontier-test', base_url: 'https://provider.test/v1', daily_model_budget_usd: 0});
}

function request(): ModelRequest {
  return {
    system: 'Matter safety core',
    messages: [{role: 'user', blocks: [{type: 'text', text: 'inspect'}]}],
    tools: [{name: 'matter_get_portfolio', description: 'portfolio', inputSchema: {type: 'object', properties: {}, additionalProperties: false}, mutating: false}],
    maxOutputTokens: 128,
    signal: new AbortController().signal,
  };
}

function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: {'content-type': 'text/event-stream'},
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('frontier provider adapters', () => {
  it('normalizes OpenAI Responses streaming tool calls and never places the key in the body', async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured = init;
      return sse([
        {type: 'response.output_item.added', output_index: 0, item: {type: 'function_call', call_id: 'call-1', name: 'matter_get_portfolio', arguments: ''}},
        {type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}'},
        {type: 'response.completed', response: {status: 'completed', usage: {input_tokens: 12, output_tokens: 4}}},
        '[DONE]',
      ]);
    }));
    const result = await new OpenAIResponsesAdapter(config('openai-responses'), 'unit-test-credential-value').run(request());
    expect(result.toolCalls).toEqual([{type: 'tool_call', id: 'call-1', name: 'matter_get_portfolio', arguments: {}}]);
    expect(result.usage).toEqual({inputTokens: 12, outputTokens: 4});
    expect(new Headers(captured?.headers).get('authorization')).toBe('Bearer unit-test-credential-value');
    expect(String(captured?.body)).not.toContain('unit-test-credential-value');
    expect(JSON.parse(String(captured?.body))).toMatchObject({store: false, stream: true});
  });

  it('normalizes OpenAI-compatible fragmented tool calls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      {choices: [{delta: {tool_calls: [{index: 0, id: 'call-2', function: {name: 'matter_', arguments: '{"asset":'}}]}}]},
      {choices: [{delta: {tool_calls: [{index: 0, function: {name: 'quote', arguments: '"AAPL","side":"buy","amount":"1"}'}}]}, finish_reason: 'tool_calls'}]},
      {choices: [], usage: {prompt_tokens: 20, completion_tokens: 8}},
      '[DONE]',
    ])));
    const result = await new OpenAICompatibleAdapter(config('openai-compatible'), null).run(request());
    expect(result.toolCalls[0]).toMatchObject({id: 'call-2', name: 'matter_quote', arguments: {asset: 'AAPL', side: 'buy', amount: '1'}});
    expect(result.stopReason).toBe('tool_calls');
  });

  it('normalizes Anthropic Messages tool-use events', async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured = init;
      return sse([
        {type: 'message_start', message: {usage: {input_tokens: 9}}},
        {type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: 'tool-1', name: 'matter_get_portfolio', input: {}}},
        {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 3}},
      ]);
    }));
    const result = await new AnthropicAdapter(config('anthropic'), 'unit-test-credential-value').run(request());
    expect(result.toolCalls[0]).toMatchObject({id: 'tool-1', name: 'matter_get_portfolio', arguments: {}});
    expect(result.usage).toEqual({inputTokens: 9, outputTokens: 3});
    expect(new Headers(captured?.headers).get('x-api-key')).toBe('unit-test-credential-value');
    expect(String(captured?.body)).not.toContain('unit-test-credential-value');
  });

  it('normalizes Gemini function calls and usage', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      capturedUrl = url;
      return sse([{candidates: [{content: {parts: [{functionCall: {name: 'matter_get_portfolio', args: {}}}]}, finishReason: 'STOP'}], usageMetadata: {promptTokenCount: 11, candidatesTokenCount: 2}}]);
    }));
    const result = await new GeminiAdapter(config('gemini'), 'AIzaProductionSecret1234567890').run(request());
    expect(capturedUrl).toContain('/models/frontier-test:streamGenerateContent?alt=sse');
    expect(result.toolCalls[0]).toMatchObject({name: 'matter_get_portfolio', arguments: {}});
    expect(result.usage).toEqual({inputTokens: 11, outputTokens: 2});
  });

  it('fails closed without reflecting provider error bodies or accepting non-stream responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret-reflection', {status: 401, headers: {'x-request-id': 'req-safe'}})));
    await expect(new OpenAICompatibleAdapter(config('openai-compatible'), 'custom-secret').run(request())).rejects.toThrow('HTTP 401 (request req-safe)');
    await expect(new OpenAICompatibleAdapter(config('openai-compatible'), 'custom-secret').run(request())).rejects.not.toThrow('secret-reflection');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})));
    await expect(new OpenAICompatibleAdapter(config('openai-compatible'), null).run(request())).rejects.toThrow('unsupported content type');
  });

  it('surfaces structured provider errors while redacting credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({error: {message: 'schema rejected for test-secret'}}), {
      status: 400, headers: {'content-type': 'application/json', 'x-request-id': 'req-schema'},
    })));
    await expect(new OpenAIResponsesAdapter(config('openai-responses'), 'test-secret').run(request())).rejects.toThrow('schema rejected for [REDACTED]');
  });

  it('keeps every strict OpenAI function schema fully required', async () => {
    let body: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return sse([{type: 'response.completed', response: {status: 'completed', usage: {input_tokens: 1, output_tokens: 1}}}, '[DONE]']);
    }));
    await new OpenAIResponsesAdapter(config('openai-responses'), 'test-secret').run({...request(), tools: MATTER_TOOLS});
    for (const tool of body.tools) {
      expect(new Set(tool.parameters.required ?? [])).toEqual(new Set(Object.keys(tool.parameters.properties ?? {})));
      expect(tool.parameters.additionalProperties).toBe(false);
    }
  });
});
