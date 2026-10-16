import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import worker from '../src/worker.mjs';
import { passwordVerifier, createSession, authenticated, TradesLoginLimiter } from '../src/auth.mjs';

const origin = 'https://example.workers.dev';
const password = 'test-only-random-password-123456789';
const env = {
  TRADES_PASSWORD_HASH: await passwordVerifier(password, '12'.repeat(16)),
  TRADES_SESSION_SECRET: '34'.repeat(32),
  TRADES_LOGIN: { idFromName: name => name, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
  ASSETS: { fetch: async () => new Response('Public page') },
  TRADES: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ cards: [] }) }) },
};
const request = (path, init = {}) => new Request(origin + path, init);
const withToken = token => ({ Cookie: '__Host-kyara-trades=' + token });
const login = (value = password, headers = {}) => request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ password: value }) });

test('Market and history remain public, and every navigation keeps the Trades link', async () => {
  for (const path of ['/', '/history', '/styles.css', '/manifest.webmanifest']) {
    assert.equal(await (await worker.fetch(request(path), env)).text(), 'Public page');
  }
  for (const file of ['index.html', 'history.html']) {
    assert.match(await readFile(new URL('../public/' + file, import.meta.url), 'utf8'), /href="\/trades"/);
  }
});

test('private Trades HTML cannot be served as a public static file', async () => {
  await assert.rejects(access(new URL('../public/trades.html', import.meta.url)));
  const config = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(config, /"run_worker_first": \["\/api\/\*", "\/trades\*"\]/);
  assert.match(config, /"preview_urls": false/);
});

test('direct Trades paths and encoded aliases only show the password form', async () => {
  for (const path of ['/trades', '/trades.html', '/trades/', '/trades%2Ehtml', '//trades//']) {
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const html = await response.text();
    assert.match(html, /type="password"/);
    assert.doesNotMatch(html, /id="trade-offers"/);
  }
  const response = await worker.fetch(request('/trades', { method: 'HEAD' }), env);
  assert.equal(await response.text(), '');
});

test('every Trades API is blocked before reaching the coordinator', async () => {
  const noCalls = { ...env, TRADES: { get: () => assert.fail('Unauthorized coordinator call') } };
  for (const path of ['/api/trades/catalog', '/api/trades/batch', '/api/trades/unknown', '/api/trades', '/api%2Ftrades/catalog']) {
    const response = await worker.fetch(request(path), noCalls);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
});

test('missing or malformed secrets fail closed on page, API and login', async () => {
  for (const broken of [{}, { TRADES_PASSWORD_HASH: env.TRADES_PASSWORD_HASH }, { ...env, TRADES_SESSION_SECRET: 'weak' }]) {
    assert.equal((await worker.fetch(request('/trades'), broken)).status, 503);
    assert.equal((await worker.fetch(request('/api/trades/catalog'), broken)).status, 401);
    assert.equal((await worker.fetch(login(), broken)).status, 503);
  }
});

test('wrong password cannot set a session; correct login creates a protected cookie', async () => {
  const wrong = await worker.fetch(login('wrong'), env);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const valid = await worker.fetch(login(), env);
  assert.equal(valid.status, 303);
  assert.equal(valid.headers.get('location'), '/trades');
  const cookie = valid.headers.get('set-cookie');
  assert.match(cookie, /^__Host-kyara-trades=/);
  assert.match(cookie, /Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800/);
  assert.doesNotMatch(cookie, new RegExp(password));
  const headers = { Cookie: cookie.split(';')[0] };
  const page = await worker.fetch(request('/trades.html', { headers }), env);
  assert.match(await page.text(), /id="trade-offers"/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const api = await worker.fetch(request('/api/trades/catalog', { headers }), env);
  assert.equal(api.status, 200);
  assert.match(api.headers.get('cache-control'), /no-store/);
});

test('signed sessions reject tampering, forgery, expiry, cross-host reuse, and changed secrets', async () => {
  const now = Date.now();
  const token = await createSession(env, origin, now);
  assert.equal(await authenticated(request('/trades', { headers: withToken(token) }), env, now), true);
  for (const invalid of ['true', 'unlocked', token.split('.')[0] + '.AAAA', 'A' + token.slice(1), token + 'junk']) {
    assert.equal(await authenticated(request('/trades', { headers: withToken(invalid) }), env, now), false);
  }
  const signedRequest = request('/trades', { headers: withToken(token) });
  assert.equal(await authenticated(signedRequest, env, now + 28800000), false);
  assert.equal(await authenticated(signedRequest, env, now - 2000), false);
  assert.equal(await authenticated(new Request('https://other.example/trades', { headers: withToken(token) }), env, now), false);
  assert.equal(await authenticated(signedRequest, { ...env, TRADES_SESSION_SECRET: '56'.repeat(32) }, now), false);
  assert.equal(await authenticated(signedRequest, { ...env, TRADES_PASSWORD_HASH: env.TRADES_PASSWORD_HASH.replace(/^12/, '56') }, now), false);
  assert.equal(await authenticated(request('/trades', { headers: { Cookie: `__Host-kyara-trades=${token}; __Host-kyara-trades=${token}` } }), env, now), false);
});

test('login and logout require same-origin POSTs and reject oversized or duplicate passwords', async () => {
  for (const path of ['/api/auth/login', '/api/auth/logout']) {
    assert.equal((await worker.fetch(request(path), env)).status, 405);
    for (const originHeader of ['https://attacker.example', 'null', '']) {
      assert.equal((await worker.fetch(request(path, { method: 'POST', headers: { Origin: originHeader } }), env)).status, 403);
    }
  }
  const oversized = login('x'.repeat(3000));
  assert.equal((await worker.fetch(oversized, env)).status, 400);
  const duplicate = request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=a&password=b' });
  assert.equal((await worker.fetch(duplicate, env)).status, 400);
  const loggedOut = await worker.fetch(request('/api/auth/logout', { method: 'POST', headers: { Origin: origin } }), env);
  assert.equal(loggedOut.status, 303);
  assert.match(loggedOut.headers.get('set-cookie'), /Max-Age=0/);
});

test('login fails closed if the shared attempt limiter is unavailable or rejects it', async () => {
  const limited = { ...env, TRADES_LOGIN: { idFromName: n => n, get: () => ({ fetch: async () => new Response(null, { status: 429 }) }) } };
  const response = await worker.fetch(login(), limited);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '900');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await worker.fetch(login(), { ...env, TRADES_LOGIN: undefined })).status, 503);
});

test('attempt limit persists across limiter instances and expires after fifteen minutes', async () => {
  const values = new Map();
  const storage = { get: async key => structuredClone(values.get(key)), put: async (key, value) => values.set(key, structuredClone(value)), transaction: async fn => fn(storage) };
  const original = Date.now;
  let time = original();
  Date.now = () => time;
  try {
    let limiter = new TradesLoginLimiter({ storage });
    const attempt = () => limiter.fetch(new Request('https://internal/attempt', { method: 'POST', body: 'a'.repeat(43) }));
    for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 204);
    limiter = new TradesLoginLimiter({ storage });
    assert.equal((await attempt()).status, 429);
    time += 900001;
    assert.equal((await attempt()).status, 204);
  } finally { Date.now = original; }
});
