import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAuth,
  signSession,
  tokenFingerprint,
} from '../../server/hosted/auth.js';
import {
  createHostedServer,
  guestMayAccess,
} from '../../server/hosted/server.js';
import { createClaudeService } from '../../server/providers/claude/index.js';
import { createClaudeSession } from '../voice/claudeSession.js';

const SECRET = 's'.repeat(40);
const OWNER = 'owner_' + 'o'.repeat(30);
const FAMILY = 'family_' + 'f'.repeat(30);
const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];
const reqWith = (cookie) => ({ headers: { cookie } });

test('guest limits: view everything, spend and save nothing', () => {
  const guest = { id: 'token:family', admin: false };
  const admin = { id: 'token:jason', admin: true };
  const cases = [
    ['POST', '/api/claude/turn', false],
    ['GET', '/api/claude/status', true],
    ['POST', '/api/realtime/token', false],
    ['POST', '/api/openai/hud-summary', false],
    ['GET', '/api/watch/state', true],
    ['GET', '/api/watch/stream', true],
    ['PUT', '/api/watch/rules/r1', false],
    ['DELETE', '/api/watch/channels/c1', false],
    ['POST', '/api/watch/alerts/a1/ack', false],
    ['GET', '/api/history/track', true],
    ['POST', '/api/history/regions', false],
    ['GET', '/api/aircraft', true],
    ['POST', '/api/overpass', true],
    ['DELETE', '/api/cctv/media/x', true],
    ['POST', '/api/watchtower', true],
  ];
  for (const [method, p, ok] of cases)
    assert.equal(guestMayAccess(guest, method, p), ok, `${method} ${p}`);
  for (const [method, p] of cases)
    assert.equal(guestMayAccess(admin, method, p), true, `admin ${method} ${p}`);
  assert.equal(guestMayAccess(null, 'POST', '/api/claude/turn'), true, 'local');
  assert.equal(
    guestMayAccess(guest, 'POST', '/api/claude/turn', { GEV_GUEST_VOICE: '1' }),
    true,
  );
  assert.equal(
    guestMayAccess(guest, 'PUT', '/api/watch/rules/r', { GEV_GUEST_VOICE: '1' }),
    false,
    'voice opt-in never unlocks saving',
  );
});

test('token sessions end when the token is removed, changed or demoted', async () => {
  const base = {
    GEV_AUTH_MODE: 'tokens',
    GEV_SESSION_SECRET: SECRET,
    GEV_ACCESS_TOKEN: OWNER,
  };
  const before = createAuth({ ...base, GEV_ACCESS_TOKENS: `family:${FAMILY}` });
  const fam = await before.login({}, { token: FAMILY });
  assert.equal(fam.user.admin, false);
  const famCookie = fam.cookie.split(';')[0];
  assert.equal(before.authenticate(reqWith(famCookie)).name, 'family');
  const own = await before.login({}, { token: OWNER });
  const ownCookie = own.cookie.split(';')[0];
  assert.equal(before.authenticate(reqWith(ownCookie)).admin, true);

  // Token changed (same name): old family session is gone, owner unaffected.
  const rotated = createAuth({
    ...base,
    GEV_ACCESS_TOKENS: `family:${'g'.repeat(30)}`,
  });
  assert.equal(rotated.authenticate(reqWith(famCookie)), null);
  assert.equal(rotated.authenticate(reqWith(ownCookie)).admin, true);

  // Token removed entirely.
  const removed = createAuth(base);
  assert.equal(removed.authenticate(reqWith(famCookie)), null);

  // Admin flag dropped: still signed in, no longer admin.
  const promoted = createAuth({ ...base, GEV_ACCESS_TOKENS: `family:${FAMILY}:admin` });
  const p = await promoted.login({}, { token: FAMILY });
  const pCookie = p.cookie.split(';')[0];
  assert.equal(promoted.authenticate(reqWith(pCookie)).admin, true);
  assert.equal(before.authenticate(reqWith(pCookie)).admin, false);

  // A validly signed cookie without a fingerprint (or a forged one) fails.
  const exp = Date.now() + 60_000;
  const legacy = signSession({ sub: 'token:owner', name: 'owner', admin: true, exp }, SECRET);
  assert.equal(before.authenticate(reqWith(`gev_session=${legacy}`)), null);
  const forged = signSession(
    { sub: 'token:owner', name: 'owner', admin: true, exp, kid: tokenFingerprint(FAMILY, SECRET) },
    SECRET,
  );
  assert.equal(before.authenticate(reqWith(`gev_session=${forged}`)), null);
});

test('hosted server: guest login can browse but not spend or save', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-guest-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
  const env = {
    GEV_AUTH_MODE: 'tokens',
    GEV_SESSION_SECRET: SECRET,
    GEV_COOKIE_SECURE: '0',
    GEV_ACCESS_TOKEN: OWNER,
    GEV_ACCESS_TOKENS: `family:${FAMILY}`,
  };
  const hits = [];
  const probe = {
    name: 'probe',
    configurePreviewServer(s) {
      for (const p of ['/api/claude', '/api/watch', '/api/aircraft'])
        s.middlewares.use(p, (req, res) => {
          hits.push(`${req.method} ${p}${req.url}`);
          res.end('{}');
        });
    },
  };
  const server = createHostedServer({ env, distDir: dist, plugins: [probe] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = async (token) =>
    cookieOf(
      await fetch(`${origin}/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    );
  try {
    const guest = await login(FAMILY);
    const owner = await login(OWNER);
    const as = (cookie, p, method = 'GET') =>
      fetch(origin + p, { method, headers: { cookie, origin }, body: method === 'GET' ? undefined : '{}' });

    let r = await as(guest, '/api/me');
    assert.deepEqual(await r.json(), { name: 'family', admin: false, voice: false });
    assert.equal((await as(guest, '/api/aircraft')).status, 200);
    assert.equal((await as(guest, '/api/watch/state')).status, 200);
    r = await as(guest, '/api/claude/turn', 'POST');
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'guest_read_only');
    assert.equal((await as(guest, '/api/watch/rules/x', 'PUT')).status, 403);
    assert.ok(!hits.some((h) => h.startsWith('POST /api/claude') || h.startsWith('PUT')), 'never reached providers');

    assert.equal((await as(owner, '/api/claude/turn', 'POST')).status, 200);
    assert.equal((await as(owner, '/api/watch/rules/x', 'PUT')).status, 200);
    assert.deepEqual(await (await as(owner, '/api/me')).json(), { name: 'owner', admin: true, voice: true });
  } finally {
    server.close();
  }
});

test('Claude status tells guests voice is off, and the adapter says so', async () => {
  const svc = createClaudeService({
    env: { ANTHROPIC_API_KEY: 'k' },
    getStore: async () => ({ listRecords: async () => [], putRecord: async () => {} }),
    fetchImpl: async () => {
      throw new Error('must not call Anthropic');
    },
  });
  const status = async (gevUser) => {
    let body;
    const res = {
      setHeader() {},
      writeHead() {},
      end(b) {
        body = JSON.parse(b);
      },
    };
    await svc.handler({ method: 'GET', url: '/status', gevUser, headers: {} }, res);
    return body;
  };
  assert.equal((await status({ id: 'token:family', admin: false })).allowed, false);
  assert.equal((await status({ id: 'token:owner', admin: true })).allowed, true);
  assert.equal((await status(undefined)).allowed, true);

  const events = [];
  const session = createClaudeSession({
    emit: (e) => events.push(e),
    runAction: async () => ({}),
    fetchImpl: async () => ({ ok: true, json: async () => ({ configured: true, allowed: false, model: 'm' }) }),
    Recognition: class {},
  });
  await session.start();
  const last = events.at(-1);
  assert.equal(last.state, 'error');
  assert.match(last.detail, /guest/);
});
