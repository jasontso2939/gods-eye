/**
 * Spend ledger for the Claude voice backend: a hard cap enforced before
 * every request, not a report after the fact.
 *
 * Before a call, the worst case (all input uncached plus max_tokens of
 * output) must fit under both the daily and the monthly cap, or the call is
 * refused without contacting Anthropic. After a call, the real cost from
 * the response's usage block is recorded.
 *
 * Prices are USD per million tokens. Keep them in step with
 * https://platform.claude.com/docs/en/about-claude/pricing
 */

export const PRICES = Object.freeze({
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
});
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

export function priceFor(model) {
  return PRICES[model] || null;
}

/** Real cost of one response from its usage block, in USD. */
export function usageCost(model, usage = {}) {
  const p = priceFor(model);
  if (!p) return null;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const input =
    n(usage.input_tokens) * p.input +
    n(usage.cache_creation_input_tokens) * p.input * CACHE_WRITE_MULT +
    n(usage.cache_read_input_tokens) * p.input * CACHE_READ_MULT;
  return (input + n(usage.output_tokens) * p.output) / 1e6;
}

/** Worst-case cost of a request before it is sent, in USD. */
export function worstCaseCost(model, inputTokens, maxOutputTokens) {
  const p = priceFor(model);
  if (!p) return null;
  return (
    (inputTokens * p.input * CACHE_WRITE_MULT + maxOutputTokens * p.output) /
    1e6
  );
}

/** Rough token estimate: ~3.5 characters per token, rounded up. */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 3.5);
}

export const monthKey = (t) => new Date(t).toISOString().slice(0, 7);
export const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * @param {object} o
 * @param {() => Promise<object>} o.getStore History store (records API).
 * @param {number} o.monthlyCapUsd
 * @param {number} o.dailyCapUsd
 * @param {() => number} [o.now]
 */
export function createSpendLedger({
  getStore,
  monthlyCapUsd,
  dailyCapUsd,
  now = Date.now,
}) {
  const KIND = 'claude-spend';
  const OWNER = '_system';
  let loaded = null;
  let chain = Promise.resolve();

  async function load() {
    if (loaded) return loaded;
    const store = await getStore();
    const rows = await store.listRecords(KIND, OWNER);
    loaded = Object.fromEntries(rows.map((r) => [r.id, Number(r.usd) || 0]));
    return loaded;
  }

  function totals(book) {
    const t = now();
    return {
      month: book[`m-${monthKey(t)}`] || 0,
      day: book[`d-${dayKey(t)}`] || 0,
    };
  }

  /** Serialize so concurrent requests cannot both squeeze under the cap. */
  function locked(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  return {
    caps: { monthlyCapUsd, dailyCapUsd },

    async status() {
      const t = totals(await load());
      return {
        monthUsd: round(t.month),
        dayUsd: round(t.day),
        monthlyCapUsd,
        dailyCapUsd,
        monthRemainingUsd: round(Math.max(0, monthlyCapUsd - t.month)),
        dayRemainingUsd: round(Math.max(0, dailyCapUsd - t.day)),
      };
    },

    /**
     * Reserve the worst case. Returns {ok:true, release(actualUsd)} or
     * {ok:false, reason}. The reservation counts against the cap until
     * released with the real cost.
     */
    reserve(worstUsd) {
      return locked(async () => {
        if (!Number.isFinite(worstUsd) || worstUsd < 0)
          return { ok: false, reason: 'unknown_price' };
        const book = await load();
        const t = totals(book);
        if (t.day + worstUsd > dailyCapUsd)
          return { ok: false, reason: 'daily_cap' };
        if (t.month + worstUsd > monthlyCapUsd)
          return { ok: false, reason: 'monthly_cap' };
        const stamp = now();
        await add(book, stamp, worstUsd);
        let released = false;
        return {
          ok: true,
          release: (actualUsd) =>
            locked(async () => {
              if (released) return;
              released = true;
              // Unknown actual cost keeps the worst case on the books.
              const actual = Number.isFinite(actualUsd) ? actualUsd : worstUsd;
              await add(book, stamp, actual - worstUsd);
            }),
        };
      });
    },
  };

  async function add(book, stamp, usd) {
    const store = await getStore();
    for (const id of [`m-${monthKey(stamp)}`, `d-${dayKey(stamp)}`]) {
      book[id] = Math.max(0, (book[id] || 0) + usd);
      await store.putRecord(KIND, OWNER, id, { usd: book[id] }, now());
    }
  }
}

const round = (v) => Math.round(v * 10000) / 10000;
