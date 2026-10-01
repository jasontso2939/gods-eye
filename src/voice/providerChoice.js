import { createRealtimeSession } from './realtimeSession.js';
import { createClaudeSession } from './claudeSession.js';

/**
 * Pick the voice backend from what the server reports.
 *
 * The status request starts as early as possible (before the globe loads),
 * so it has long settled by the time the voice control is built. If it has
 * not, or it failed, the existing OpenAI Realtime backend is used.
 */
export function createVoiceProviderChoice({
  fetchImpl = (...a) => fetch(...a),
  realtime = createRealtimeSession,
  claude = createClaudeSession,
} = {}) {
  let provider = null;
  const ready = fetchImpl('/api/claude/status', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      provider = d?.provider === 'claude' && d.configured ? 'claude' : 'openai';
      return provider;
    })
    .catch(() => {
      provider = 'openai';
      return provider;
    });
  return {
    ready,
    get provider() {
      return provider;
    },
    createSession: (hooks) =>
      provider === 'claude' ? claude(hooks) : realtime(hooks),
  };
}
