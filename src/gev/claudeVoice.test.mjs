import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStore } from '../../server/providers/store/store.js';
import { sqliteDriver } from '../../server/providers/store/drivers.js';
import {
  createSpendLedger,
  usageCost,
  worstCaseCost,
  estimateTokens,
} from '../../server/providers/claude/ledger.js';
import {
  createClaudeService,
  claudeConfig,
  toClaudeTools,
  sanitizeMessages,
} from '../../server/providers/claude/index.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import {
  createClaudeSession,
  trimHistory,
  spokenText,
  formatBudget,
} from '../voice/claudeSession.js';
import { createVoiceProviderChoice } from '../voice/providerChoice.js';

const T0 = Date.UTC(2026, 9, 1, 12);
const MODEL = 'claude-haiku-4-5-20251001';

async function memoryStore() {
  const store = createStore(await sqliteDriver(':memory:'));
  await store.init();
  return store;
}

test('cost math follows the published per-million-token prices', () => {
  // Haiku 4.5: $1 in, $5 out, cache write 1.25x, cache read 0.1x.
  const usd = usageCost(MODEL, {
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 10000,
    cache_read_input_tokens: 0,
  });
  assert.ok(Math.abs(usd - (1000 + 200 * 5 + 10000 * 1.25) / 1e6) < 1e-12);
  const cached = usageCost(MODEL, { input_tokens: 100, cache_read_input_tokens: 14000, output_tokens: 50 });
  assert.ok(Math.abs(cached - (100 + 1400 + 250) / 1e6) < 1e-12);
  assert.equal(usageCost('unknown-model', {}), null);
  assert.ok(worstCaseCost(MODEL, 15000, 600) > cached);
  assert.equal(estimateTokens('x'.repeat(35)), 10);
});

test('ledger refuses before the cap and records real cost after', async () => {
  const store = await memoryStore();
  let t = T0;
  const ledger = createSpendLedger({ getStore: async () => store, monthlyCapUsd: 1, dailyCapUsd: 0.1, now: () => t });
  const a = await ledger.reserve(0.06);
  assert.equal(a.ok, true);
  assert.equal((await ledger.reserve(0.06)).reason, 'daily_cap', 'reservation counts until released');
  await a.release(0.01);
  assert.equal((await ledger.status()).dayUsd, 0.01);
  const b = await ledger.reserve(0.06);
  assert.equal(b.ok, true);
  await b.release(null); // unknown actual keeps the worst case
  assert.equal((await ledger.status()).dayUsd, 0.07);
  t += 86_400_000; // next day: daily resets, monthly carries
  const s = await ledger.status();
  assert.equal(s.dayUsd, 0);
  assert.equal(s.monthUsd, 0.07);
  // Spend 9 cents a day (under the daily cap) until the $1 month is full.
  let refusal = null;
  for (let i = 0; i < 20 && !refusal; i++) {
    t += 86_400_000;
    const h = await ledger.reserve(0.09);
    if (h.ok) await h.release(0.09);
    else refusal = h.reason;
  }
  assert.equal(refusal, 'monthly_cap');
  assert.ok((await ledger.status()).monthUsd <= 1);
  assert.equal((await ledger.reserve(-1)).reason, 'unknown_price');
});

test('ledger survives a restart because it lives in the store', async () => {
  const store = await memoryStore();
  const mk = () => createSpendLedger({ getStore: async () => store, monthlyCapUsd: 5, dailyCapUsd: 1, now: () => T0 });
  const h = await mk().reserve(0.5);
  await h.release(0.42);
  assert.equal((await mk().status()).dayUsd, 0.42);
});

test('concurrent reservations cannot both squeeze under the cap', async () => {
  const store = await memoryStore();
  const ledger = createSpendLedger({ getStore: async () => store, monthlyCapUsd: 5, dailyCapUsd: 0.1, now: () => T0 });
  const results = await Promise.all([ledger.reserve(0.08), ledger.reserve(0.08), ledger.reserve(0.08)]);
  assert.deepEqual(results.map((r) => r.ok), [true, false, false]);
});

test('config, tool conversion and message validation', () => {
  assert.equal(claudeConfig({}).enabled, false);
  assert.equal(claudeConfig({}).provider, 'openai');
  const c = claudeConfig({ ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual([c.enabled, c.provider, c.model, c.monthlyCapUsd, c.dailyCapUsd], [true, 'claude', MODEL, 5, 1]);
  assert.equal(claudeConfig({ ANTHROPIC_API_KEY: 'k', GEV_VOICE_PROVIDER: 'openai' }).enabled, false);
  assert.equal(claudeConfig({ GEV_CLAUDE_MAX_TOKENS: '99999' }).maxTokens, 4000);

  const tools = toClaudeTools(GEV_REALTIME_TOOLS);
  assert.equal(tools.length, GEV_REALTIME_TOOLS.length);
  for (const t of tools) {
    assert.deepEqual(Object.keys(t).sort(), ['description', 'input_schema', 'name']);
    assert.equal(t.input_schema.type, 'object');
  }

  assert.throws(() => sanitizeMessages([]), /non-empty/);
  assert.throws(() => sanitizeMessages([{ role: 'system', content: 'x' }]), /role/);
  assert.throws(() => sanitizeMessages([{ role: 'user', content: [{ type: 'image' }] }]), /not allowed/);
  assert.throws(() => sanitizeMessages([{ role: 'user', content: [{ type: 'tool_use', id: 'a', name: 'b' }] }]), /not allowed/);
  const clean = sanitizeMessages([
    { role: 'user', content: 'go to austin', extra: 1 },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'fly_to_location', input: { query: 'Austin' }, junk: true }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: { ok: true } }] },
  ]);
  assert.equal(clean[0].extra, undefined);
  assert.equal(clean[1].content[0].junk, undefined);
  assert.equal(clean[2].content[0].content, '{"ok":true}');
});

async function serve(service) {
  const server = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/claude/, '') || '/';
    service.handler(req, res, () => ((res.statusCode = 404), res.end('{}')));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/api/claude` };
}

test('turn: forwards to Anthropic with caching, records spend, refuses past the cap', async () => {
  const store = await memoryStore();
  const sent = [];
  const fakeAnthropic = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'fly_to_location', input: { query: 'Austin' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 40, cache_creation_input_tokens: 14000, cache_read_input_tokens: 0, output_tokens: 60 },
      }),
    };
  };
  const svc = createClaudeService({
    env: { ANTHROPIC_API_KEY: 'sk-test', GEV_CLAUDE_DAILY_CAP_USD: '0.05', GEV_CLAUDE_MONTHLY_CAP_USD: '1' },
    fetchImpl: fakeAnthropic,
    getStore: async () => store,
    now: () => T0,
  });
  const { server, base } = await serve(svc);
  try {
    let r = await fetch(`${base}/status`);
    let s = await r.json();
    assert.equal(s.configured, true);
    assert.equal(s.budget.dailyCapUsd, 0.05);
    assert.ok(!JSON.stringify(s).includes('sk-test'), 'key never leaves the server');

    r = await fetch(`${base}/turn`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'take me to Austin' }] }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.content[0].name, 'fly_to_location');
    assert.ok(body.costUsd > 0.017 && body.costUsd < 0.019, String(body.costUsd));

    const call = sent[0];
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.init.headers['x-api-key'], 'sk-test');
    assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.body.model, MODEL);
    assert.deepEqual(call.body.system[0].cache_control, { type: 'ephemeral' });
    assert.match(call.body.system[0].text, /read aloud/);
    assert.equal(call.body.tools.length, GEV_REALTIME_TOOLS.length);

    // Two more turns push past the 5-cent daily cap; the third is refused
    // without contacting Anthropic.
    let refused = null;
    for (let i = 0; i < 4 && !refused; i++) {
      r = await fetch(`${base}/turn`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'again' }] }) });
      if (r.status === 429) refused = await r.json();
    }
    assert.equal(refused.error, 'budget_exceeded');
    assert.equal(refused.reason, 'daily_cap');
    const callsBefore = sent.length;
    r = await fetch(`${base}/turn`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'again' }] }) });
    assert.equal(r.status, 429);
    assert.equal(sent.length, callsBefore, 'refused calls never reach Anthropic');

    r = await fetch(`${base}/turn`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'system', content: 'x' }] }) });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test('turn: upstream errors map to fixed codes and are not billed', async () => {
  const store = await memoryStore();
  const svc = createClaudeService({
    env: { ANTHROPIC_API_KEY: 'bad' },
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }) }),
    getStore: async () => store,
    now: () => T0,
  });
  const out = await svc.turn([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(out, { status: 502, body: { error: 'bad_api_key' } });
  assert.equal((await svc.ledger.status()).dayUsd, 0);
  const off = createClaudeService({ env: {}, getStore: async () => store });
  const { server, base } = await serve(off);
  try {
    const r = await fetch(`${base}/turn`, { method: 'POST', body: '{"messages":[{"role":"user","content":"x"}]}' });
    assert.equal(r.status, 503);
  } finally {
    server.close();
  }
});

test('browser helpers', () => {
  const h = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ];
  const t = trimHistory(h, 3);
  assert.equal(t[0].content, 'b', 'never starts on an orphaned tool_result');
  assert.equal(spokenText([{ type: 'text', text: '**Flying** to Austin.' }, { type: 'tool_use' }]), 'Flying to Austin.');
  assert.equal(formatBudget({ monthRemainingUsd: 4.5, dayRemainingUsd: 0.8 }), '$0.80 left');
});

function fakeSpeech() {
  const spoken = [];
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  const synth = {
    speak(u) {
      spoken.push(u.text);
      setTimeout(() => u.onend?.(), 0);
    },
    cancel() {},
  };
  class Recognition {
    start() {}
    abort() {}
  }
  return { spoken, synth, Utterance, Recognition };
}

test('browser adapter runs the tool loop and speaks the final answer', async () => {
  const speech = fakeSpeech();
  const events = [];
  const calls = [];
  const replies = [
    { content: [{ type: 'tool_use', id: 'tu1', name: 'fly_to_location', input: { query: 'Austin' } }] },
    { content: [{ type: 'text', text: 'Flying to Austin.' }], budget: { monthRemainingUsd: 4.9, dayRemainingUsd: 0.95 } },
  ];
  const fetchImpl = async (url, init) => {
    if (url === '/api/claude/status')
      return { ok: true, json: async () => ({ configured: true, provider: 'claude', model: MODEL, budget: { monthRemainingUsd: 5, dayRemainingUsd: 1 } }) };
    calls.push(JSON.parse(init.body).messages);
    return { ok: true, json: async () => replies.shift() };
  };
  const ran = [];
  const session = createClaudeSession({
    emit: (e) => events.push(e),
    runAction: async (name, args) => (ran.push([name, args]), { ok: true, arrived: 'Austin' }),
    fetchImpl,
    ...speech,
  });
  await session.start();
  await session.sendText('take me to Austin');
  assert.deepEqual(ran, [['fly_to_location', { query: 'Austin' }]]);
  assert.equal(calls.length, 2);
  const second = calls[1];
  assert.equal(second.at(-1).content[0].type, 'tool_result');
  assert.equal(second.at(-1).content[0].tool_use_id, 'tu1');
  assert.deepEqual(speech.spoken, ['Flying to Austin.']);
  assert.ok(events.some((e) => e.type === 'state' && e.state === 'executing'));
  assert.ok(events.some((e) => e.type === 'state' && /\$0\.95 left/.test(e.detail || '')));
  session.stop();
  assert.equal(events.at(-1).state, 'idle');
});

test('browser adapter: budget refusal is spoken and the history stays valid', async () => {
  const speech = fakeSpeech();
  const events = [];
  const fetchImpl = async (url) => {
    if (url === '/api/claude/status') return { ok: true, json: async () => ({ configured: true, provider: 'claude', model: MODEL }) };
    return { ok: false, status: 429, json: async () => ({ error: 'budget_exceeded', reason: 'daily_cap', budget: { monthRemainingUsd: 3, dayRemainingUsd: 0 } }) };
  };
  const session = createClaudeSession({ emit: (e) => events.push(e), runAction: async () => ({}), fetchImpl, ...speech });
  await session.start();
  await session.sendText('hello');
  assert.deepEqual(speech.spoken, ['My voice budget is used up.']);
  assert.deepEqual(session.history, []);
  assert.ok(events.some((e) => /Voice budget reached/.test(e.detail || '')));
});

test('browser adapter refuses to start without speech recognition or server config', async () => {
  const events = [];
  const s1 = createClaudeSession({ emit: (e) => events.push(e), runAction: async () => ({}), Recognition: undefined, fetchImpl: async () => ({}) });
  await s1.start();
  assert.match(events.at(-1).detail, /no speech recognition/);
  const s2 = createClaudeSession({
    emit: (e) => events.push(e),
    runAction: async () => ({}),
    ...fakeSpeech(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ configured: false }) }),
  });
  await s2.start();
  assert.equal(events.at(-1).state, 'error');
});

test('provider choice follows the server and falls back to OpenAI', async () => {
  const pick = async (status) => {
    const c = createVoiceProviderChoice({
      fetchImpl: async () => status,
      realtime: () => 'openai-adapter',
      claude: () => 'claude-adapter',
    });
    await c.ready;
    return c.createSession({});
  };
  assert.equal(await pick({ ok: true, json: async () => ({ provider: 'claude', configured: true }) }), 'claude-adapter');
  assert.equal(await pick({ ok: true, json: async () => ({ provider: 'openai', configured: false }) }), 'openai-adapter');
  assert.equal(await pick({ ok: false }), 'openai-adapter');
  const failing = createVoiceProviderChoice({ fetchImpl: async () => { throw new Error('offline'); }, realtime: () => 'openai-adapter', claude: () => 'claude-adapter' });
  await failing.ready;
  assert.equal(failing.createSession({}), 'openai-adapter');
});
