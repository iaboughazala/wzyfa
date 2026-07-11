/**
 * Facebook Page + X (Twitter) auto-poster.
 *
 * Facebook: Meta Graph API, needs a long-lived Page Access Token.
 *   Env: FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN
 *
 * X: v2 tweets endpoint via OAuth 1.0a (works on the free tier).
 *   Env: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *
 * Free tiers (as of setup):
 *   FB Graph — free, no per-call quota that matters at 3–10/day.
 *   X Free  — 500 POSTs/month per app; 3–10/day fits fine.
 */

const crypto = require('crypto');

// ─── Facebook ───

function isFacebookConfigured() {
  return Boolean(process.env.FB_PAGE_ID && process.env.FB_PAGE_ACCESS_TOKEN);
}

// Exchange the current page token for a fresh 60-day one. Called by a weekly
// cron so the token never gets within a week of expiry (safe margin against
// a missed run). Needs FB_APP_ID + FB_APP_SECRET to be set — if either is
// missing, we silently skip (someone opted for a permanent user-flow token
// and doesn't need auto-refresh).
async function refreshFacebookToken() {
  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  const current = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!appId || !appSecret || !current) {
    return { skipped: true, reason: 'FB_APP_ID / FB_APP_SECRET / FB_PAGE_ACCESS_TOKEN not fully set' };
  }
  const url = 'https://graph.facebook.com/v18.0/oauth/access_token?' + new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: current,
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`FB token refresh failed: ${(data.error && data.error.message) || res.status}`);
  }
  // Mutate process.env so future posts see the new token immediately.
  // The .env file on disk is updated separately by server.js so the token
  // persists across restarts.
  process.env.FB_PAGE_ACCESS_TOKEN = data.access_token;
  return { ok: true, expiresIn: data.expires_in, token: data.access_token };
}

async function postToFacebook({ message, link }) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/v18.0/${pageId}/feed`;
  const body = new URLSearchParams({
    message,
    link: link || '',
    access_token: token,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = (data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(`Facebook post failed: ${errMsg}`);
  }
  return { id: data.id || null, raw: data };
}

// ─── X (Twitter) — OAuth 1.0a signing for POST /2/tweets ───

function isXConfigured() {
  return Boolean(
    process.env.X_API_KEY &&
      process.env.X_API_SECRET &&
      process.env.X_ACCESS_TOKEN &&
      process.env.X_ACCESS_SECRET
  );
}

// Percent-encode per RFC 3986 (OAuth spec).
function pct(s) {
  return encodeURIComponent(s)
    .replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Sign a request with OAuth 1.0a HMAC-SHA1 and return the Authorization header.
function oauth1Header({ method, url, apiKey, apiSecret, accessToken, accessSecret }) {
  const params = {
    oauth_consumer_key: apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params)
    .sort()
    .map(k => `${pct(k)}=${pct(params[k])}`)
    .join('&');
  const signatureBase = [method.toUpperCase(), pct(url), pct(paramString)].join('&');
  const signingKey = `${pct(apiSecret)}&${pct(accessSecret)}`;
  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(signatureBase)
    .digest('base64');
  const authParams = { ...params, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(authParams)
      .sort()
      .map(k => `${pct(k)}="${pct(authParams[k])}"`)
      .join(', ')
  );
}

async function postToX({ text }) {
  const url = 'https://api.twitter.com/2/tweets';
  const auth = oauth1Header({
    method: 'POST',
    url,
    apiKey: process.env.X_API_KEY,
    apiSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg =
      (data.errors && data.errors[0] && data.errors[0].message) ||
      data.detail ||
      data.title ||
      `HTTP ${res.status}`;
    throw new Error(`X post failed: ${errMsg}`);
  }
  return { id: (data.data && data.data.id) || null, raw: data };
}

// ─── Post formatting ─────────────────────────────────────────────────────

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://wzyfa.com';

// Shared post body — used verbatim for FB, and for X unless a header trim
// is needed to fit 280 chars. Jobs without an email are filtered upstream
// so we can assume job.email exists.
function buildPostLines(job) {
  const uploadUrl = `${PUBLIC_BASE}/careers?job=${job.id}`;
  const location = job.location || job.country;
  const lines = [];
  if (job.title) lines.push(`🎯 ${job.title}`);
  if (job.company) lines.push(`🏢 ${job.company}`);
  if (location) lines.push(`📍 ${location}`);
  if (job.workMode) lines.push(`💼 ${job.workMode}`);
  lines.push(`📩 Send your CV: ${job.email}`);
  lines.push(`📤 Submit your CV: ${uploadUrl}`);
  return { lines, uploadUrl };
}

function formatForFacebook(job) {
  return buildPostLines(job).lines.join('\n');
}

// X — 280 char limit. t.co collapses each link to 23 chars.
function formatForX(job) {
  const { lines, uploadUrl } = buildPostLines(job);
  const full = lines.join('\n');
  // The link is inside the last line; substitute its length with the t.co
  // budget when measuring against Twitter's counter.
  const measured = full.length - uploadUrl.length + 23;
  if (measured <= 280) return full;
  // Over budget — trim the title (first line) which is the only piece we
  // can safely shorten without losing critical info.
  const excess = measured - 280 + 1; // +1 for the ellipsis
  const trimmedFirst = lines[0].slice(0, lines[0].length - excess) + '…';
  return [trimmedFirst, ...lines.slice(1)].join('\n');
}

module.exports = {
  isFacebookConfigured,
  postToFacebook,
  refreshFacebookToken,
  isXConfigured,
  postToX,
  formatForFacebook,
  formatForX,
};
