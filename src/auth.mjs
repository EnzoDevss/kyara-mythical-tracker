const encoder = new TextEncoder();
const COOKIE = '__Host-kyara-trades';
const SESSION_SECONDS = 8 * 60 * 60;
export const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Vary': 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
};
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const cookie = (value, seconds = SESSION_SECONDS) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
const ready = env => /^[a-f0-9]{32}:[a-f0-9]{64}$/.test(env.TRADES_PASSWORD_HASH || '') && /^[a-f0-9]{64}$/.test(env.TRADES_SESSION_SECRET || '');
const key = env => crypto.subtle.importKey('raw', encoder.encode(env.TRADES_SESSION_SECRET + ':' + env.TRADES_PASSWORD_HASH), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
export const privateJSON = (error, status, extra = {}) => Response.json({ error }, { status, headers: { ...PRIVATE_HEADERS, ...extra } });

export async function passwordVerifier(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bytes = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100000 }, material, 256);
  return salt + ':' + Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createSession(env, origin, now = Date.now()) {
  const payload = encode(encoder.encode(JSON.stringify({ scope: 'trades', aud: origin, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + SESSION_SECONDS })));
  const signature = await crypto.subtle.sign('HMAC', await key(env), encoder.encode(payload));
  return `${payload}.${encode(signature)}`;
}

export async function authenticated(request, env, now = Date.now()) {
  if (!ready(env)) return false;
  try {
    const matches = (request.headers.get('Cookie') || '').split(';').map(c => c.trim()).filter(c => c.startsWith(COOKIE + '='));
    if (matches.length !== 1) return false;
    const token = matches[0].slice(COOKIE.length + 1);
    if (token.length > 1024 || !/^[\w-]+\.[\w-]+$/.test(token)) return false;
    const [payload, signature] = token.split('.');
    if (!await crypto.subtle.verify('HMAC', await key(env), decode(signature), encoder.encode(payload))) return false;
    const data = JSON.parse(new TextDecoder().decode(decode(payload)));
    const seconds = Math.floor(now / 1000);
    return data.scope === 'trades' && data.aud === new URL(request.url).origin && Number.isInteger(data.iat) && Number.isInteger(data.exp)
      && data.iat <= seconds && data.exp > seconds && data.exp - data.iat === SESSION_SECONDS;
  } catch { return false; }
}

function loginPage(message = '', status = 200, extra = {}) {
  // Message strings are fixed by the server; no request content is inserted into HTML.
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0d0c11"><title>Unlock Trades · Kyara Market</title><link rel="stylesheet" href="/styles.css?v=columns-3"><link rel="stylesheet" href="/history.css?v=hourly-1"><link rel="stylesheet" href="/auth.css?v=2"><link rel="icon" href="/icons/app-192.png"></head><body><div class="shell"><header class="masthead"><a class="brand" href="/" aria-label="Kyara Market Tracker home"><span class="brand-mark" aria-hidden="true">◆</span><span>KYARA<span class="brand-sub">MARKET TRACKER</span></span></a><nav class="page-nav" aria-label="Main navigation"><a href="/">Market</a><a href="/history">Price history</a><a href="/trades" aria-current="page">Trades</a></nav></header><main class="auth-main"><section class="auth-panel"><p class="eyebrow">TRADE BOARD</p><h1>Unlock Trades.</h1><p>Enter the shared password to access trade offers.</p>${message ? `<p class="auth-error" role="alert">${message}</p>` : ''}<form action="/api/auth/login" method="post"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" autofocus><button class="button" type="submit">Unlock Trades</button></form><a class="auth-guest" href="/">Continue as guest</a><p class="auth-note">Market and Price history are open to everyone.</p></section></main></div></body></html>`, { status, headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', ...extra } });
}

function sameOrigin(request) {
  return request.headers.get('Origin') === new URL(request.url).origin && !['cross-site', 'none'].includes(request.headers.get('Sec-Fetch-Site'));
}

async function boundedForm(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) throw new Error('Bad form');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  let length = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2048) { await reader.cancel(); throw new Error('Body too large'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  const fields = new URLSearchParams(text);
  if (fields.getAll('password').length !== 1) throw new Error('Bad password field');
  const password = fields.get('password');
  if (!password || password.length > 256) throw new Error('Bad password length');
  return password;
}

export async function authResponse(request, env, path) {
  if (path === '/trades' || path === '/trades.html') {
    if (!['GET', 'HEAD'].includes(request.method)) return privateJSON('Method not allowed.', 405, { Allow: 'GET, HEAD' });
    if (await authenticated(request, env)) return null;
    const response = ready(env) ? loginPage() : loginPage('Trades access is temporarily unavailable.', 503);
    return request.method === 'HEAD' ? new Response(null, response) : response;
  }
  if (path !== '/api/auth/login' && path !== '/api/auth/logout') return privateJSON('Unknown endpoint.', 404);
  if (request.method !== 'POST') return privateJSON('Method not allowed.', 405, { Allow: 'POST' });
  if (!sameOrigin(request)) return privateJSON('Same-origin form required.', 403);
  if (path === '/api/auth/logout') return new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, Location: '/trades', 'Set-Cookie': cookie('', 0) } });
  if (!ready(env) || !env.TRADES_LOGIN) return loginPage('Trades access is temporarily unavailable.', 503);
  let password;
  try { password = await boundedForm(request); } catch { return loginPage('Enter a valid password.', 400); }
  // Cloudflare supplies this header. Store only its keyed fingerprint in the limiter.
  const fingerprint = encode(await crypto.subtle.sign('HMAC', await key(env), encoder.encode(request.headers.get('CF-Connecting-IP') || 'unknown')));
  try {
    const limiter = env.TRADES_LOGIN.get(env.TRADES_LOGIN.idFromName('login-attempts-v1'));
    const allowed = await limiter.fetch(new Request('https://internal/attempt', { method: 'POST', body: fingerprint }));
    if (!allowed.ok) return loginPage('Too many password attempts. Try again in 15 minutes.', 429, { 'Retry-After': '900' });
  } catch { return loginPage('Trades access is temporarily unavailable.', 503); }
  const expected = env.TRADES_PASSWORD_HASH;
  const actual = await passwordVerifier(password, expected.split(':')[0]);
  // Compare with native constant-time HMAC verification, not JavaScript string equality.
  const verificationKey = await key(env);
  const proof = await crypto.subtle.sign('HMAC', verificationKey, encoder.encode(expected));
  if (!await crypto.subtle.verify('HMAC', verificationKey, proof, encoder.encode(actual))) return loginPage('Incorrect password.', 401);
  return new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, Location: '/trades', 'Set-Cookie': cookie(await createSession(env, new URL(request.url).origin)) } });
}

export class TradesLoginLimiter {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const fingerprint = await request.text();
    if (request.method !== 'POST' || !/^[\w-]{43}$/.test(fingerprint)) return new Response(null, { status: 400 });
    const now = Date.now(), cutoff = now - 15 * 60 * 1000;
    const allowed = await this.ctx.storage.transaction(async storage => {
      const previous = await storage.get('attempts') || { entries: {}, global: [] };
      const entries = Object.fromEntries(Object.entries(previous.entries).map(([id, times]) => [id, times.filter(t => t > cutoff)]).filter(([, times]) => times.length));
      const global = previous.global.filter(t => t > now - 60000);
      const times = entries[fingerprint] || [];
      if (times.length >= 5 || global.length >= 100) return false;
      times.push(now); entries[fingerprint] = times; global.push(now);
      await storage.put('attempts', { entries, global });
      return true;
    });
    return new Response(null, { status: allowed ? 204 : 429 });
  }
}
