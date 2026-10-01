import { GEV_REALTIME_TOOLS } from '../openai/tools.js';
import { realtimeInstructions } from '../openai/instructions.js';
import { getStore } from '../store/index.js';
import {
  sendJson,
  sendError,
  readJson,
  parseUrl,
  route,
  badRequest,
} from '../common/json.js';
import {
  createSpendLedger,
  usageCost,
  worstCaseCost,
  estimateTokens,
  priceFor,
} from './ledger.js';

/**
 * Vite plugin: Claude as the brain behind voice control.
 *
 *   GET  /api/claude/status   whether Claude voice is configured, plus spend
 *   POST /api/claude/turn     {messages} -> one Messages API response
 *
 * The browser turns speech into text, sends the conversation here, runs any
 * tool calls Claude returns against the existing map actions, and sends the
 * results back until Claude answers in words, which the browser speaks.
 *
 * The API key never leaves the server. Every call passes the spend ledger
 * first; once the daily or monthly cap would be crossed, calls are refused
 * without reaching Anthropic.
 *
 * Environment:
 *   ANTHROPIC_API_KEY             required to enable
 *   GEV_VOICE_PROVIDER            'claude' | 'openai' (default: claude when a key is set)
 *   GEV_CLAUDE_MODEL              default claude-haiku-4-5-20251001
 *   GEV_CLAUDE_MONTHLY_CAP_USD    default 5
 *   GEV_CLAUDE_DAILY_CAP_USD      default 1
 *   GEV_CLAUDE_MAX_TOKENS         reply cap per call, default 600
 */

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_MESSAGES = 40;
const MAX_BODY = 256 * 1024;
const MAX_TOOL_RESULT_CHARS = 12000;

const SPOKEN_PREFACE = [
  'Your replies are read aloud by the browser speech synthesizer, so:',
  '- Answer in one or two short spoken sentences. No markdown, lists, emoji or URLs.',
  '- Spell out numbers naturally only when that helps speech; keep codes like UAL428 as written.',
  'The user speaks through browser speech recognition, so expect small transcription errors in names; prefer the most plausible place or callsign.',
  'You cannot see the screen. Use get_entity_context and get_current_view_state for anything about what is in view.',
].join('\n');

/** Convert the app's function-tool definitions to Messages API tools. */
export function toClaudeTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));
}

export function claudeConfig(env = process.env) {
  const key = env.ANTHROPIC_API_KEY || '';
  const provider =
    env.GEV_VOICE_PROVIDER === 'openai' || env.GEV_VOICE_PROVIDER === 'claude'
      ? env.GEV_VOICE_PROVIDER
      : key
        ? 'claude'
        : 'openai';
  const num = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : d;
  };
  return {
    key,
    enabled: Boolean(key) && provider === 'claude',
    provider,
    model: env.GEV_CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
    monthlyCapUsd: num(env.GEV_CLAUDE_MONTHLY_CAP_USD, 5),
    dailyCapUsd: num(env.GEV_CLAUDE_DAILY_CAP_USD, 1),
    maxTokens: Math.min(
      4000,
      Math.max(64, num(env.GEV_CLAUDE_MAX_TOKENS, 600)),
    ),
    // Operator-only override (tests, or an approved gateway). Never from a request.
    apiUrl: /^https?:\/\//.test(env.GEV_CLAUDE_API_URL || '')
      ? env.GEV_CLAUDE_API_URL
      : DEFAULT_API_URL,
  };
}

const BLOCK_TYPES = {
  user: new Set(['text', 'tool_result']),
  assistant: new Set(['text', 'tool_use']),
};

/** Validate and clamp the client-held conversation. */
export function sanitizeMessages(input) {
  if (!Array.isArray(input) || !input.length)
    badRequest('messages must be a non-empty array');
  if (input.length > MAX_MESSAGES)
    badRequest(`at most ${MAX_MESSAGES} messages`);
  return input.map((m) => {
    if (m?.role !== 'user' && m?.role !== 'assistant')
      badRequest('role must be user or assistant');
    if (typeof m.content === 'string') {
      if (!m.content.trim()) badRequest('empty message');
      return { role: m.role, content: m.content.slice(0, 4000) };
    }
    if (!Array.isArray(m.content) || !m.content.length)
      badRequest('content must be text or blocks');
    const content = m.content.map((b) => {
      if (!BLOCK_TYPES[m.role].has(b?.type))
        badRequest(`block type ${b?.type} not allowed for ${m.role}`);
      if (b.type === 'text')
        return {
          type: 'text',
          text: String(b.text || '').slice(0, 4000) || ' ',
        };
      if (b.type === 'tool_use') {
        if (typeof b.id !== 'string' || typeof b.name !== 'string')
          badRequest('tool_use needs id and name');
        return {
          type: 'tool_use',
          id: b.id,
          name: b.name,
          input: b.input && typeof b.input === 'object' ? b.input : {},
        };
      }
      if (typeof b.tool_use_id !== 'string')
        badRequest('tool_result needs tool_use_id');
      const text =
        typeof b.content === 'string'
          ? b.content
          : JSON.stringify(b.content ?? '');
      return {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: text.slice(0, MAX_TOOL_RESULT_CHARS),
        ...(b.is_error ? { is_error: true } : {}),
      };
    });
    return { role: m.role, content };
  });
}

export function createClaudeService({
  env = process.env,
  fetchImpl = fetch,
  getStore: storeOf = getStore,
  now = Date.now,
} = {}) {
  const config = claudeConfig(env);
  const tools = toClaudeTools(GEV_REALTIME_TOOLS);
  const system = [
    {
      type: 'text',
      text: `${SPOKEN_PREFACE}\n\n${realtimeInstructions()}`,
      // Tools and system are the same every call: cache them (tools sort
      // before system, so this one breakpoint covers both).
      cache_control: { type: 'ephemeral' },
    },
  ];
  const fixedTokens =
    estimateTokens(system[0].text) + estimateTokens(tools) + 600;
  const ledger = createSpendLedger({
    getStore: storeOf,
    monthlyCapUsd: config.monthlyCapUsd,
    dailyCapUsd: config.dailyCapUsd,
    now,
  });
  const stats = { calls: 0, refused: 0, upstreamErrors: 0 };

  async function turn(messages) {
    const clean = sanitizeMessages(messages);
    const inputTokens = fixedTokens + estimateTokens(clean);
    const worst = worstCaseCost(config.model, inputTokens, config.maxTokens);
    const hold = await ledger.reserve(worst ?? NaN);
    if (!hold.ok) {
      stats.refused++;
      return {
        status: 429,
        body: {
          error: 'budget_exceeded',
          reason: hold.reason,
          budget: await ledger.status(),
        },
      };
    }
    let actual = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let res;
      try {
        res = await fetchImpl(config.apiUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-api-key': config.key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: config.maxTokens,
            system,
            tools,
            messages: clean,
          }),
        });
      } finally {
        clearTimeout(timer);
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        stats.upstreamErrors++;
        // A rejected request is not billed.
        actual = 0;
        console.error(
          '[claude] upstream',
          res.status,
          data?.error?.type,
          data?.error?.message?.slice?.(0, 200),
        );
        const code =
          res.status === 401
            ? 'bad_api_key'
            : res.status === 429
              ? 'upstream_rate_limited'
              : res.status === 529
                ? 'upstream_overloaded'
                : res.status === 400 &&
                    /credit/i.test(data?.error?.message || '')
                  ? 'out_of_credits'
                  : 'upstream_error';
        return { status: 502, body: { error: code } };
      }
      stats.calls++;
      actual = usageCost(config.model, data?.usage);
      return {
        status: 200,
        body: {
          content: Array.isArray(data?.content) ? data.content : [],
          stop_reason: data?.stop_reason || null,
          costUsd: actual,
          budget: null,
        },
      };
    } catch (error) {
      stats.upstreamErrors++;
      actual = 0;
      console.error('[claude] request failed:', error?.message);
      return { status: 502, body: { error: 'upstream_unreachable' } };
    } finally {
      await hold.release(actual);
    }
  }

  const handler = route('claude', async (req, res, next) => {
    const { path } = parseUrl(req);
    if (req.method === 'GET' && path === '/status') {
      return sendJson(res, 200, {
        provider: config.provider,
        configured: config.enabled,
        model: config.enabled ? config.model : null,
        priced: Boolean(priceFor(config.model)),
        budget: config.enabled ? await ledger.status() : null,
        stats,
      });
    }
    if (req.method === 'POST' && path === '/turn') {
      if (!config.enabled) return sendError(res, 503, 'claude_not_configured');
      if (!priceFor(config.model))
        return sendError(res, 503, 'unknown_model_price');
      const body = await readJson(req, MAX_BODY);
      const out = await turn(body?.messages);
      if (out.status === 200) out.body.budget = await ledger.status();
      return sendJson(res, out.status, out.body);
    }
    if (typeof next === 'function') return next();
    return sendError(res, 404, 'not_found');
  });

  return { handler, turn, ledger, config, stats };
}

export function claudeProvider({ env = process.env } = {}) {
  let service = null;
  const install = (server) => {
    service ||= createClaudeService({ env });
    server.middlewares.use('/api/claude', service.handler);
  };
  return {
    name: 'gev-claude',
    configureServer: install,
    configurePreviewServer: install,
  };
}
