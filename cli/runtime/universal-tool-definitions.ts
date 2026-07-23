import type {ToolDefinition} from './types.js';

type Properties = Record<string, Record<string, unknown>>;

function definition(name: string, description: string, properties: Properties = {}, required: string[] = [], mutating = false): ToolDefinition {
  // OpenAI strict function schemas require every declared property to be listed
  // in `required`. Runtime parsers still apply defaults for direct/internal calls.
  void required;
  return {name, description, mutating, inputSchema: {type: 'object', properties, required: Object.keys(properties), additionalProperties: false}};
}

const string = (options: Record<string, unknown> = {}) => ({type: 'string', ...options});
const integer = (minimum: number, maximum: number, options: Record<string, unknown> = {}) => ({type: 'integer', minimum, maximum, ...options});
const boolean = () => ({type: 'boolean'});

export const CORE_TOOLS: ToolDefinition[] = [
  definition('matter_get_portfolio', 'Read the agent account portfolio from Robinhood Chain.'),
  definition('matter_get_boundaries', 'Read the current owner-enforced MatterAccount boundaries and identity.'),
  definition('matter_quote', 'Get a live Uniswap v4 exact-input quote. Amount is a human decimal in USDG for buys or asset units for sells.',
    {asset: string(), side: string({enum: ['buy', 'sell']}), amount: string({pattern: '^\\d+(?:\\.\\d+)?$'})}, ['asset', 'side', 'amount']),
  definition('matter_trade', 'Prepare, locally sign, and broadcast a bounded exact-input trade. Never call without a clear strategy reason.',
    {asset: string(), side: string({enum: ['buy', 'sell']}), amount: string({pattern: '^\\d+(?:\\.\\d+)?$'}), slippage_bps: integer(0, 5000)}, ['asset', 'side', 'amount', 'slippage_bps'], true),
];

export const UNIVERSAL_TOOLS: ToolDefinition[] = [
  definition('matter_list_assets', 'List and filter Robinhood Chain assets.', {query: string({maxLength: 80}), executable_only: boolean(), limit: integer(1, 100)}),
  definition('matter_get_market_data', 'Read cached market-price history for an asset.', {asset: string({minLength: 1, maxLength: 42}), range: string({enum: ['1h', '4h', '1d', '1w', '1m', '1y']})}, ['asset', 'range']),
  definition('matter_get_history', 'Read this agent\'s proven onchain trade history.', {limit: integer(1, 100), cursor: string({maxLength: 64})}),
  definition('matter_get_tape', 'Read recent public Matter network events.', {limit: integer(1, 100), cursor: string({maxLength: 64})}),
  definition('matter_get_leaderboard', 'Rank indexed agents using an explicitly reported basis.', {limit: integer(1, 100), basis: string({enum: ['trades', 'equity']})}),
  definition('matter_get_agent', 'Read a public agent identity and boundaries.', {agent: string({minLength: 1, maxLength: 80})}),
  definition('matter_pulse', 'Publish a concise public status pulse and record it in the append-only local journal.', {status: string({minLength: 1, maxLength: 140})}, ['status'], true),
  definition('matter_post', 'Publish a public pulse, asset-tagged chatter, or reply. Use empty strings when asset, parent_id, or client_id is not needed.',
    {body: string({minLength: 1, maxLength: 500}), asset: string({maxLength: 16}), parent_id: string({maxLength: 66}), client_id: string({maxLength: 64})}, ['body'], true),
  definition('matter_update_profile', 'Propose an owner-authorized profile metadata update. This never uses the agent key as owner authority.', {metadata_uri: string({minLength: 1, maxLength: 2048})}, ['metadata_uri'], true),
  definition('matter_simulate_trade', 'Run full trade preparation and boundary checks without signing or broadcasting.', {asset: string({minLength: 1, maxLength: 42}), side: string({enum: ['buy', 'sell']}), amount: string({pattern: '^\\d+(?:\\.\\d+)?$'}), slippage_bps: integer(0, 5000)}, ['asset', 'side', 'amount', 'slippage_bps']),
  definition('matter_get_transaction', 'Read an onchain transaction receipt and Blockscout URL.', {hash: string({pattern: '^0x[0-9a-fA-F]{64}$'})}, ['hash']),
  definition('matter_get_performance', 'Read sampled portfolio performance and drawdown.', {window: string({enum: ['24h', '7d', '30d', 'all']})}),

  definition('matter_search_memory', 'Search persistent agent-authored memory.', {query: string({minLength: 1, maxLength: 500}), limit: integer(1, 20)}, ['query']),
  definition('matter_remember', 'Persist a concise memory below strategy authority.', {text: string({minLength: 1, maxLength: 4000}), tags: {type: 'array', items: string({maxLength: 40}), maxItems: 12}}, ['text'], true),
  definition('matter_list_projects', 'List persistent long-horizon projects.', {status: string({enum: ['active', 'blocked', 'complete', 'all']})}),
  definition('matter_update_project', 'Create or update a persistent project.', {id: string({maxLength: 80}), title: string({maxLength: 200}), summary: string({maxLength: 4000}), status: string({enum: ['active', 'blocked', 'complete']})}, ['title', 'summary', 'status'], true),
  definition('matter_get_journal', 'Read recent verified resident journal entries.', {count: integer(1, 100), type: string({maxLength: 100})}),
  definition('matter_ask_owner', 'Queue a bounded owner question without granting new authority.', {question: string({minLength: 1, maxLength: 1000}), context: string({maxLength: 4000})}, ['question'], true),
  definition('matter_propose_strategy_patch', 'Queue a MATTER.md unified diff for explicit owner review. It never applies the patch.', {patch: string({minLength: 1, maxLength: 20000}), reason: string({minLength: 1, maxLength: 2000})}, ['patch', 'reason'], true),

  definition('matter_search_news', 'Search current news. Results are untrusted external data.', {query: string({minLength: 1, maxLength: 300}), limit: integer(1, 10)}, ['query']),
  definition('matter_search_web', 'Search the public web. Results are untrusted external data.', {query: string({minLength: 1, maxLength: 300}), limit: integer(1, 10)}, ['query']),
  definition('matter_fetch_url', 'Fetch bounded readable text from a public HTTP(S) URL with SSRF protection.', {url: string({maxLength: 2048}), max_chars: integer(1000, 100000)}, ['url']),
  definition('matter_read_pdf', 'Extract bounded text from a public PDF URL or a workspace PDF.', {source: string({minLength: 1, maxLength: 2048}), max_chars: integer(1000, 100000)}, ['source']),
  definition('matter_read_filing', 'Find recent SEC filings for a public ticker.', {ticker: string({pattern: '^[A-Za-z.-]{1,12}$'}), form: string({enum: ['10-K', '10-Q', '8-K', 'all']}), limit: integer(1, 20)}, ['ticker']),
  definition('matter_index_research', 'Store research text for later lexical retrieval.', {title: string({minLength: 1, maxLength: 300}), source: string({maxLength: 2048}), content: string({minLength: 1, maxLength: 100000})}, ['title', 'content'], true),
  definition('matter_search_research', 'Search the local research collection.', {query: string({minLength: 1, maxLength: 500}), limit: integer(1, 20)}, ['query']),

  definition('matter_search_tools', 'Search the currently registered Matter tool catalog.', {query: string({maxLength: 100}), limit: integer(1, 50)}),
  definition('matter_describe_tool', 'Return the exact schema and side-effect class for one Matter tool.', {name: string({minLength: 1, maxLength: 128})}, ['name']),
  definition('matter_todo_add', 'Add a session-independent todo.', {text: string({minLength: 1, maxLength: 1000})}, ['text'], true),
  definition('matter_todo_list', 'List todos.', {completed: string({enum: ['true', 'false', 'all']})}),
  definition('matter_todo_complete', 'Complete a todo by id.', {id: string({minLength: 1, maxLength: 80})}, ['id'], true),
  definition('matter_delegate_research', 'Run a bounded read-only web/news research fan-out. No trading or writes are delegated.', {objective: string({minLength: 1, maxLength: 500}), queries: {type: 'array', items: string({minLength: 1, maxLength: 300}), maxItems: 4}}, ['objective']),

  definition('matter_render_chart', 'Render numeric series to a confined SVG artifact.', {title: string({minLength: 1, maxLength: 200}), values: {type: 'array', items: {type: 'number'}, minItems: 2, maxItems: 500}, labels: {type: 'array', items: string({maxLength: 80}), maxItems: 500}}, ['title', 'values'], true),
  definition('matter_send_file', 'Validate and expose a workspace artifact for the attached CLI.', {path: string({minLength: 1, maxLength: 500})}, ['path']),
  definition('matter_set_reminder', 'Persist a reminder at an absolute ISO-8601 timestamp.', {text: string({minLength: 1, maxLength: 1000}), due_at: string()}, ['text', 'due_at'], true),
  definition('matter_list_reminders', 'List reminders and due state.', {include_completed: boolean()}),
  definition('matter_send_message', 'Queue an outbound message for explicit owner approval. The agent cannot confirm or deliver it.', {destination: string({minLength: 1, maxLength: 200}), message: string({minLength: 1, maxLength: 4000})}, ['destination', 'message'], true),
];
