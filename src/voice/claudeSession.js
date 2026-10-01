/**
 * Claude voice adapter for the common voice session (see session.js).
 *
 * Speech in:  the browser's SpeechRecognition (Chrome, Edge, Safari).
 * Thinking:   POST /api/claude/turn; the server holds the API key and the
 *             spend cap. Tool calls Claude returns run through the same map
 *             actions OpenAI Realtime uses, and their results go back to
 *             Claude until it answers in words.
 * Speech out: the browser's speechSynthesis.
 *
 * Push-to-talk and the OpenAI cost tier are not offered: the mic button
 * toggles listening, and spend is shown from the server's ledger.
 */

const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY = 16;
const MAX_RESULT_CHARS = 8000;

export const CLAUDE_ERRORS = Object.freeze({
  budget_exceeded:
    'Voice budget reached. It resets with the next day or month.',
  claude_not_configured: 'Claude voice is not configured on this server.',
  bad_api_key: "The server's Anthropic API key was rejected.",
  out_of_credits: 'The Anthropic account is out of prepaid credits.',
  upstream_rate_limited: 'Claude is rate limited right now. Try again shortly.',
  upstream_overloaded: 'Claude is busy right now. Try again shortly.',
  upstream_unreachable: 'Could not reach Claude.',
  quota_exceeded: 'Too many voice requests this hour.',
});

/** Drop the oldest turns, keeping the history starting at a plain user turn. */
export function trimHistory(history, max = MAX_HISTORY) {
  const out = history.slice();
  while (out.length > max) {
    out.shift();
    while (
      out.length &&
      !(out[0].role === 'user' && typeof out[0].content === 'string')
    )
      out.shift();
  }
  return out;
}

/** Spoken text from an assistant content array. */
export function spokenText(content) {
  return (content || [])
    .filter((b) => b?.type === 'text' && b.text)
    .map((b) => b.text.trim())
    .join(' ')
    .replace(/[*_#`>]/g, '')
    .trim();
}

export function formatBudget(budget) {
  if (!budget) return '';
  const left = Math.min(budget.monthRemainingUsd, budget.dayRemainingUsd);
  return `$${left.toFixed(2)} left`;
}

function resultText(value) {
  let text;
  try {
    text =
      typeof value === 'string' ? value : JSON.stringify(value ?? { ok: true });
  } catch {
    text = String(value);
  }
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}…[truncated]`
    : text;
}

export function createClaudeSession({
  emit,
  runAction,
  signal,
  fetchImpl = (...a) => fetch(...a),
  Recognition = globalThis.SpeechRecognition ||
    globalThis.webkitSpeechRecognition,
  synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
}) {
  let active = false;
  let recognition = null;
  let listening = false;
  let speaking = false;
  let busy = false;
  let pending = null;
  let history = [];
  let budget = null;
  let generation = 0;

  const detail = (text) =>
    budget ? `${text} · ${formatBudget(budget)}` : text;
  const setState = (state, text) =>
    emit({ type: 'state', state, detail: detail(text) });

  function listen() {
    if (!active || speaking || listening || !recognition) return;
    try {
      recognition.start();
      listening = true;
    } catch {
      // start() throws if already started; the end handler restarts it.
    }
  }

  function makeRecognition() {
    const r = new Recognition();
    r.continuous = true;
    r.interimResults = false;
    r.lang = globalThis.navigator?.language || 'en-US';
    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          const text = String(res[0]?.transcript || '').trim();
          if (text) void handle(text);
        }
      }
    };
    r.onend = () => {
      listening = false;
      // Browsers end recognition after silence; keep listening while on.
      if (active && !speaking) setTimeout(listen, 250);
    };
    r.onerror = (event) => {
      listening = false;
      if (
        event?.error === 'not-allowed' ||
        event?.error === 'service-not-allowed'
      ) {
        active = false;
        setState('error', 'Microphone permission was denied.');
      }
    };
    return r;
  }

  function speak(text) {
    if (!text || !synth || !Utterance) return Promise.resolve();
    return new Promise((resolve) => {
      speaking = true;
      try {
        recognition?.abort();
      } catch {
        /* not running */
      }
      listening = false;
      const u = new Utterance(text);
      const done = () => {
        speaking = false;
        resolve();
        listen();
      };
      u.onend = done;
      u.onerror = done;
      synth.speak(u);
    });
  }

  async function callClaude(messages) {
    const res = await fetchImpl('/api/claude/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ messages }),
    });
    const data = await res.json().catch(() => ({}));
    if (data?.budget) budget = data.budget;
    if (!res.ok) {
      const error = new Error(
        CLAUDE_ERRORS[data?.error] || 'Claude request failed.',
      );
      error.code = data?.error || `http_${res.status}`;
      throw error;
    }
    return data;
  }

  async function handle(text) {
    if (!active) return;
    if (busy) {
      pending = text; // keep only the newest request while busy
      return;
    }
    busy = true;
    const epoch = ++generation;
    const before = history;
    emit({ type: 'transcript', role: 'user', text, final: true });
    history = trimHistory([...history, { role: 'user', content: text }]);
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        setState('executing', round ? 'Running map actions' : 'Thinking');
        const reply = await callClaude(history);
        if (!active || epoch !== generation) return;
        const content = reply.content || [];
        history.push({ role: 'assistant', content });
        const uses = content.filter((b) => b?.type === 'tool_use');
        if (!uses.length) {
          const said = spokenText(content);
          emit({
            type: 'transcript',
            role: 'assistant',
            text: said,
            final: true,
          });
          emit({ type: 'completion' });
          setState('listening', 'Listening');
          await speak(said);
          break;
        }
        const results = [];
        for (const use of uses) {
          try {
            const value = await runAction(use.name, use.input || {});
            results.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: resultText(value),
            });
          } catch (error) {
            results.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: `Action failed: ${error?.message || error}`,
              is_error: true,
            });
          }
          if (!active || epoch !== generation) return;
        }
        history.push({ role: 'user', content: results });
        if (round === MAX_TOOL_ROUNDS - 1) {
          setState('listening', 'Listening');
          await speak('That took too many steps, so I stopped.');
        }
      }
    } catch (error) {
      // Drop the whole failed exchange (including any half-finished tool
      // round) so the next request starts from a valid conversation.
      history = before;
      if (!active) return;
      setState('listening', error.message);
      await speak(
        error.code === 'budget_exceeded'
          ? 'My voice budget is used up.'
          : 'Sorry, that did not work.',
      );
    } finally {
      busy = false;
      if (active && pending) {
        const next = pending;
        pending = null;
        void handle(next);
      }
    }
  }

  async function refreshBudget() {
    try {
      const res = await fetchImpl('/api/claude/status', {
        credentials: 'same-origin',
      });
      const data = await res.json();
      budget = data?.budget || budget;
      return data;
    } catch {
      return null;
    }
  }

  signal?.addEventListener('abort', () => stop(), { once: true });

  async function start() {
    if (active) return;
    if (!Recognition) {
      setState(
        'error',
        'This browser has no speech recognition. Use Chrome, Edge or Safari, or type a command.',
      );
      return;
    }
    setState('connecting', 'Connecting to Claude');
    const status = await refreshBudget();
    if (!status?.configured) {
      setState('error', CLAUDE_ERRORS.claude_not_configured);
      return;
    }
    active = true;
    recognition = makeRecognition();
    listen();
    setState('listening', `Listening · ${status.model}`);
  }

  function stop() {
    active = false;
    generation++;
    pending = null;
    try {
      recognition?.abort();
    } catch {
      /* not running */
    }
    recognition = null;
    listening = false;
    synth?.cancel?.();
    speaking = false;
    emit({ type: 'state', state: 'idle', detail: 'Voice off' });
  }

  return {
    capabilities: {
      costControls: false,
      pushToTalk: false,
      provider: 'claude',
    },
    start,
    stop,
    sendText: (text) => {
      const clean = String(text || '').trim();
      return active && clean ? handle(clean) : Promise.resolve();
    },
    // Map events (annotation outlines) are informational for this backend.
    sendMapEvent: () => {},
    get history() {
      return history.slice();
    },
  };
}
