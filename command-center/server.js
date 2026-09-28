'use strict';

/*
 * Command Center local server.
 *
 * Zero external dependencies — Node built-ins only, so there is nothing to
 * `npm install`. Binds to 127.0.0.1 only. Serves the dashboard, proxies a
 * single read-only /api/inbox endpoint to Gmail and Microsoft Graph, and
 * handles the one-time OAuth sign-in for each account.
 *
 * Nothing in this file logs or serves token values. Grep the file for
 * "SECRET-SAFE" comments at the few spots where that matters most.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { URL } = require('url');

const PORT = 8877;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_DIR = path.join(__dirname, 'config');
const GOOGLE_CONFIG_PATH = path.join(CONFIG_DIR, 'google-oauth-client.json');
const MICROSOFT_CONFIG_PATH = path.join(CONFIG_DIR, 'microsoft-oauth-client.json');

// Tokens live entirely outside this project folder (and therefore outside git).
const SECRETS_DIR = path.join(os.homedir(), '.command-center-secrets');
const TOKENS_PATH = path.join(SECRETS_DIR, 'tokens.json');

const GOOGLE_REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth/google/callback`;
const MICROSOFT_REDIRECT_URI = `http://localhost:${PORT}/oauth/microsoft/callback`;
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MICROSOFT_SCOPE = 'offline_access Mail.Read';
const MICROSOFT_TENANT = 'common';

const MIN_REFRESH_INTERVAL_MS = 60 * 1000; // never hit providers more than once/minute
const AUTOREFRESH_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function newState() {
  return base64url(crypto.randomBytes(16));
}

function readJsonIfExists(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // A malformed config file is treated the same as "not configured", but
    // we log the filename (never contents) so the user can find the typo.
    console.error(`Could not read ${filePath}: ${err.message}`);
    return null;
  }
}

function loadGoogleConfig() {
  const json = readJsonIfExists(GOOGLE_CONFIG_PATH);
  if (!json) return null;
  const block = json.installed || json.web;
  if (!block || !block.client_id || !block.client_secret) return null;
  return { clientId: block.client_id, clientSecret: block.client_secret };
}

function loadMicrosoftConfig() {
  const json = readJsonIfExists(MICROSOFT_CONFIG_PATH);
  if (!json || !json.client_id) return null;
  return { clientId: json.client_id, tenant: json.tenant || MICROSOFT_TENANT };
}

function loadTokens() {
  const json = readJsonIfExists(TOKENS_PATH);
  return json || {};
}

function saveTokens(tokens) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(SECRETS_DIR, 0o700); } catch (_) { /* best-effort on non-POSIX */ }
  const tmp = TOKENS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tokens), { mode: 0o600 });
  fs.renameSync(tmp, TOKENS_PATH);
  try { fs.chmodSync(TOKENS_PATH, 0o600); } catch (_) { /* best-effort on non-POSIX */ }
}

function httpsRequestJson({ method, hostname, path: reqPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method, hostname, path: reqPath, headers, timeout: 15000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_) { /* leave null */ }
          resolve({ statusCode: res.statusCode, headers: res.headers, json: parsed, raw: data });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function form(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? `open "${url}"`
    : platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* best-effort; ignore failures (e.g. headless box) */ });
}

class NeedsReauthError extends Error {}
class NotConfiguredError extends Error {}

// ---------------------------------------------------------------------------
// OAuth: pending authorization requests (in-memory, short-lived)
// ---------------------------------------------------------------------------

const pendingAuth = new Map(); // state -> { provider, verifier, createdAt }

function prunePendingAuth() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, entry] of pendingAuth) {
    if (entry.createdAt < cutoff) pendingAuth.delete(state);
  }
}

// ---------------------------------------------------------------------------
// Google (Gmail)
// ---------------------------------------------------------------------------

function buildGoogleAuthUrl(challenge, state) {
  const cfg = loadGoogleConfig();
  if (!cfg) throw new NotConfiguredError('google not configured');
  const params = form({
    client_id: cfg.clientId,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeGoogleCode(code, verifier) {
  const cfg = loadGoogleConfig();
  if (!cfg) throw new NotConfiguredError('google not configured');
  const body = form({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const res = await httpsRequestJson({
    method: 'POST',
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (res.statusCode !== 200 || !res.json || !res.json.refresh_token) {
    // SECRET-SAFE: do not log res.raw / res.json, it can contain tokens.
    throw new Error(`google token exchange failed (status ${res.statusCode})`);
  }
  return res.json; // { access_token, refresh_token, expires_in, ... }
}

async function refreshGoogleAccessToken(refreshToken) {
  const cfg = loadGoogleConfig();
  if (!cfg) throw new NotConfiguredError('google not configured');
  const body = form({
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await httpsRequestJson({
    method: 'POST',
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (res.statusCode === 400 || res.statusCode === 401) {
    const errCode = res.json && res.json.error;
    if (errCode === 'invalid_grant') throw new NeedsReauthError('google refresh token invalid');
  }
  if (res.statusCode !== 200 || !res.json || !res.json.access_token) {
    throw new Error(`google token refresh failed (status ${res.statusCode})`);
  }
  return res.json; // { access_token, expires_in, ... } (no new refresh_token normally)
}

function gmailGet(reqPath, accessToken) {
  return httpsRequestJson({
    method: 'GET',
    hostname: 'gmail.googleapis.com',
    path: reqPath,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function fetchGmailInbox(accessToken) {
  // Unread count for the inbox: exact, from the label itself. No message content involved.
  const labelRes = await gmailGet('/gmail/v1/users/me/labels/INBOX?fields=messagesUnread', accessToken);
  if (labelRes.statusCode === 401) throw new NeedsReauthError('gmail 401');
  if (labelRes.statusCode === 429 || labelRes.statusCode >= 500) throw new Error(`gmail rate/temp error ${labelRes.statusCode}`);
  if (labelRes.statusCode !== 200) throw new Error(`gmail labels.get failed ${labelRes.statusCode}`);
  const unread = labelRes.json.messagesUnread || 0;

  // Exact unread+important count: page through message IDs only (no bodies/snippets).
  let unreadImportant = 0;
  let pageToken = '';
  let pages = 0;
  do {
    const q = form({ q: 'in:inbox is:unread is:important', maxResults: 100, ...(pageToken ? { pageToken } : {}) });
    const listRes = await gmailGet(`/gmail/v1/users/me/messages?${q}&fields=messages/id,nextPageToken,resultSizeEstimate`, accessToken);
    if (listRes.statusCode === 401) throw new NeedsReauthError('gmail 401');
    if (listRes.statusCode === 429 || listRes.statusCode >= 500) throw new Error(`gmail rate/temp error ${listRes.statusCode}`);
    if (listRes.statusCode !== 200) throw new Error(`gmail messages.list failed ${listRes.statusCode}`);
    unreadImportant += (listRes.json.messages || []).length;
    pageToken = listRes.json.nextPageToken || '';
    pages += 1;
  } while (pageToken && pages < 20);

  // Five newest unread items: list candidate IDs, fetch minimal metadata (From + date
  // only — the `fields` filter below strips subject/snippet/body/labels entirely),
  // then sort by actual timestamp ourselves rather than trusting list order.
  const listQ = form({ q: 'in:inbox is:unread', maxResults: 15 });
  const idsRes = await gmailGet(`/gmail/v1/users/me/messages?${listQ}&fields=messages/id`, accessToken);
  if (idsRes.statusCode === 401) throw new NeedsReauthError('gmail 401');
  if (idsRes.statusCode !== 200) throw new Error(`gmail messages.list failed ${idsRes.statusCode}`);
  const ids = (idsRes.json.messages || []).map((m) => m.id);

  const metaFields = encodeURIComponent('id,internalDate,payload/headers');
  const metas = await Promise.all(ids.map((id) =>
    gmailGet(`/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&fields=${metaFields}`, accessToken)
  ));

  const items = metas
    .filter((r) => r.statusCode === 200 && r.json)
    .map((r) => {
      const headers = (r.json.payload && r.json.payload.headers) || [];
      const fromHeader = headers.find((h) => h.name === 'From');
      const sender = fromHeader ? parseDisplayName(fromHeader.value) : 'Unknown sender';
      const ts = Number(r.json.internalDate || 0);
      return {
        sender,
        time: new Date(ts).toISOString(),
        link: `https://mail.google.com/mail/u/0/#inbox/${r.json.id}`,
        ts,
      };
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)
    .map(({ ts, ...rest }) => rest);

  return { unread, unreadImportant, items };
}

function parseDisplayName(fromValue) {
  // "Display Name <addr@example.com>" -> "Display Name"; falls back to the raw address.
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(fromValue);
  const name = match ? match[1].trim() : fromValue.trim();
  return name || fromValue;
}

// ---------------------------------------------------------------------------
// Microsoft (Outlook / Hotmail via Graph)
// ---------------------------------------------------------------------------

function buildMicrosoftAuthUrl(challenge, state) {
  const cfg = loadMicrosoftConfig();
  if (!cfg) throw new NotConfiguredError('microsoft not configured');
  const params = form({
    client_id: cfg.clientId,
    redirect_uri: MICROSOFT_REDIRECT_URI,
    response_type: 'code',
    scope: MICROSOFT_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/authorize?${params}`;
}

async function exchangeMicrosoftCode(code, verifier) {
  const cfg = loadMicrosoftConfig();
  if (!cfg) throw new NotConfiguredError('microsoft not configured');
  const body = form({
    code,
    client_id: cfg.clientId,
    redirect_uri: MICROSOFT_REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: verifier,
    scope: MICROSOFT_SCOPE,
  });
  const res = await httpsRequestJson({
    method: 'POST',
    hostname: 'login.microsoftonline.com',
    path: `/${cfg.tenant}/oauth2/v2.0/token`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (res.statusCode !== 200 || !res.json || !res.json.refresh_token) {
    throw new Error(`microsoft token exchange failed (status ${res.statusCode})`);
  }
  return res.json;
}

async function refreshMicrosoftAccessToken(refreshToken) {
  const cfg = loadMicrosoftConfig();
  if (!cfg) throw new NotConfiguredError('microsoft not configured');
  const body = form({
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    grant_type: 'refresh_token',
    scope: MICROSOFT_SCOPE,
  });
  const res = await httpsRequestJson({
    method: 'POST',
    hostname: 'login.microsoftonline.com',
    path: `/${cfg.tenant}/oauth2/v2.0/token`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (res.statusCode === 400) {
    const errCode = res.json && res.json.error;
    if (errCode === 'invalid_grant') throw new NeedsReauthError('microsoft refresh token invalid');
  }
  if (res.statusCode !== 200 || !res.json || !res.json.access_token) {
    throw new Error(`microsoft token refresh failed (status ${res.statusCode})`);
  }
  return res.json; // may or may not include a new refresh_token
}

function graphGet(reqPath, accessToken, extraHeaders) {
  return httpsRequestJson({
    method: 'GET',
    hostname: 'graph.microsoft.com',
    path: reqPath,
    headers: { Authorization: `Bearer ${accessToken}`, ...extraHeaders },
  });
}

async function fetchOutlookInbox(accessToken) {
  const folderRes = await graphGet('/v1.0/me/mailFolders/inbox?$select=unreadItemCount', accessToken);
  if (folderRes.statusCode === 401) throw new NeedsReauthError('graph 401');
  if (folderRes.statusCode === 429 || folderRes.statusCode >= 500) throw new Error(`graph rate/temp error ${folderRes.statusCode}`);
  if (folderRes.statusCode !== 200) throw new Error(`graph mailFolders failed ${folderRes.statusCode}`);
  const unread = folderRes.json.unreadItemCount || 0;

  const importantQ = form({
    '$filter': "isRead eq false and importance eq 'high'",
    '$count': 'true',
    '$top': 1,
    '$select': 'id',
  });
  const importantRes = await graphGet(
    `/v1.0/me/mailFolders/inbox/messages?${importantQ}`,
    accessToken,
    { ConsistencyLevel: 'eventual' }
  );
  if (importantRes.statusCode === 401) throw new NeedsReauthError('graph 401');
  if (importantRes.statusCode !== 200) throw new Error(`graph important count failed ${importantRes.statusCode}`);
  const unreadImportant = importantRes.json['@odata.count'] || 0;

  const itemsQ = form({
    '$filter': 'isRead eq false',
    '$orderby': 'receivedDateTime desc',
    '$top': 5,
    '$count': 'true',
    '$select': 'from,receivedDateTime,webLink',
  });
  const itemsRes = await graphGet(
    `/v1.0/me/mailFolders/inbox/messages?${itemsQ}`,
    accessToken,
    { ConsistencyLevel: 'eventual' }
  );
  if (itemsRes.statusCode === 401) throw new NeedsReauthError('graph 401');
  if (itemsRes.statusCode !== 200) throw new Error(`graph messages failed ${itemsRes.statusCode}`);

  const items = (itemsRes.json.value || []).map((m) => ({
    sender: (m.from && m.from.emailAddress && (m.from.emailAddress.name || m.from.emailAddress.address)) || 'Unknown sender',
    time: m.receivedDateTime,
    link: m.webLink,
  }));

  return { unread, unreadImportant, items };
}

// ---------------------------------------------------------------------------
// Per-account orchestration: token refresh + caching + error classification
// ---------------------------------------------------------------------------

const cache = {
  google: { data: null, updatedAt: null, status: 'loading', nextAllowedAttempt: 0, refreshing: false },
  microsoft: { data: null, updatedAt: null, status: 'loading', nextAllowedAttempt: 0, refreshing: false },
};

async function getValidAccessToken(provider) {
  const tokens = loadTokens();
  const entry = tokens[provider];
  const cfg = provider === 'google' ? loadGoogleConfig() : loadMicrosoftConfig();
  if (!cfg) throw new NotConfiguredError(`${provider} not configured`);
  if (!entry || !entry.refreshToken) throw new NeedsReauthError(`${provider} needs sign-in`);

  const now = Date.now();
  if (entry.accessToken && entry.accessTokenExpiresAt && entry.accessTokenExpiresAt - 60000 > now) {
    return entry.accessToken;
  }

  const refreshed = provider === 'google'
    ? await refreshGoogleAccessToken(entry.refreshToken)
    : await refreshMicrosoftAccessToken(entry.refreshToken);

  const updated = {
    ...entry,
    accessToken: refreshed.access_token,
    accessTokenExpiresAt: now + (refreshed.expires_in || 3000) * 1000,
    refreshToken: refreshed.refresh_token || entry.refreshToken,
  };
  const allTokens = loadTokens();
  allTokens[provider] = updated;
  saveTokens(allTokens);
  return updated.accessToken;
}

async function refreshAccountCache(provider) {
  const slot = cache[provider];
  if (slot.refreshing) return; // de-dupe concurrent refresh requests
  if (Date.now() < slot.nextAllowedAttempt) return;
  slot.refreshing = true;
  try {
    const accessToken = await getValidAccessToken(provider);
    const data = provider === 'google'
      ? await fetchGmailInbox(accessToken)
      : await fetchOutlookInbox(accessToken);
    slot.data = data;
    slot.updatedAt = new Date().toISOString();
    slot.status = 'ok';
    slot.nextAllowedAttempt = Date.now() + MIN_REFRESH_INTERVAL_MS;
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      slot.status = 'not_configured';
    } else if (err instanceof NeedsReauthError) {
      // The stored refresh token is dead; clear it so the UI cleanly asks to sign in again.
      const tokens = loadTokens();
      delete tokens[provider];
      saveTokens(tokens);
      slot.status = 'needs_reauth';
    } else {
      // Network failure (e.g. offline) or provider-side rate limit / 5xx.
      slot.status = slot.data ? 'stale' : 'temporary_error';
      // SECRET-SAFE: log only the message, never request/response bodies.
      console.error(`[${provider}] refresh failed: ${err.message}`);
    }
    slot.nextAllowedAttempt = Date.now() + MIN_REFRESH_INTERVAL_MS;
  } finally {
    slot.refreshing = false;
  }
}

function accountPayload(provider) {
  const slot = cache[provider];
  return {
    status: slot.status,
    updatedAt: slot.updatedAt,
    unread: slot.data ? slot.data.unread : null,
    unreadImportant: slot.data ? slot.data.unreadImportant : null,
    items: slot.data ? slot.data.items : [],
  };
}

setInterval(() => {
  refreshAccountCache('google');
  refreshAccountCache('microsoft');
}, AUTOREFRESH_MS);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function isAllowedHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1';
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

function serveStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { sendHtml(res, 404, '<h1>Not found</h1>'); return; }
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
    res.end(data);
  });
}

async function handleAuthStart(provider, res) {
  try {
    const { verifier, challenge } = newPkce();
    const state = newState();
    prunePendingAuth();
    pendingAuth.set(state, { provider, verifier, createdAt: Date.now() });
    const url = provider === 'google' ? buildGoogleAuthUrl(challenge, state) : buildMicrosoftAuthUrl(challenge, state);
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      sendHtml(res, 400, `<h1>${provider} is not configured</h1><p>Add the credential file and restart the server.</p>`);
    } else {
      sendHtml(res, 500, '<h1>Could not start sign-in</h1>');
    }
  }
}

async function handleOAuthCallback(provider, query, res) {
  const { code, state, error } = query;
  const pending = state && pendingAuth.get(state);
  if (pending) pendingAuth.delete(state);

  if (error) {
    sendHtml(res, 400, `<h1>Sign-in cancelled</h1><p>${escapeHtml(error)}</p><p>You can close this tab.</p>`);
    return;
  }
  if (!code || !pending || pending.provider !== provider) {
    sendHtml(res, 400, '<h1>Invalid or expired sign-in request</h1><p>Please try signing in again from the dashboard.</p>');
    return;
  }

  try {
    const tokenResponse = provider === 'google'
      ? await exchangeGoogleCode(code, pending.verifier)
      : await exchangeMicrosoftCode(code, pending.verifier);

    const tokens = loadTokens();
    tokens[provider] = {
      refreshToken: tokenResponse.refresh_token,
      accessToken: tokenResponse.access_token,
      accessTokenExpiresAt: Date.now() + (tokenResponse.expires_in || 3000) * 1000,
    };
    saveTokens(tokens);
    cache[provider].status = 'loading';
    refreshAccountCache(provider);

    sendHtml(res, 200, `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;">
      <h1>Signed in</h1><p>${provider === 'google' ? 'Gmail' : 'Outlook'} is connected. You can close this tab and go back to the dashboard.</p>
      <script>setTimeout(() => window.close(), 1500);</script>
    </body></html>`);
  } catch (err) {
    console.error(`[${provider}] token exchange failed: ${err.message}`);
    sendHtml(res, 500, '<h1>Sign-in failed</h1><p>Please close this tab and try again from the dashboard.</p>');
  }
}

function handleSignOut(provider, res) {
  const tokens = loadTokens();
  delete tokens[provider];
  saveTokens(tokens);
  cache[provider] = { data: null, updatedAt: null, status: 'needs_reauth', nextAllowedAttempt: 0, refreshing: false };
  sendJson(res, 200, { ok: true });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const server = http.createServer((req, res) => {
  if (!isAllowedHost(req.headers.host)) {
    sendHtml(res, 403, '<h1>Forbidden</h1><p>This server only answers requests addressed to localhost.</p>');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams.entries());

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/command-center-desktop.html')) {
    serveStaticFile(res, path.join(PUBLIC_DIR, 'command-center-desktop.html'), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204); res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/inbox') {
    const force = query.refresh === '1';
    const jobs = [];
    for (const provider of ['google', 'microsoft']) {
      const cfg = provider === 'google' ? loadGoogleConfig() : loadMicrosoftConfig();
      if (!cfg) { cache[provider].status = 'not_configured'; continue; }
      const tokens = loadTokens();
      if (!tokens[provider] || !tokens[provider].refreshToken) { cache[provider].status = 'needs_reauth'; continue; }
      if (force || cache[provider].status === 'loading' || !cache[provider].data) {
        jobs.push(refreshAccountCache(provider));
      }
    }
    Promise.all(jobs).then(() => {
      sendJson(res, 200, { google: accountPayload('google'), microsoft: accountPayload('microsoft') });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/google/start') { handleAuthStart('google', res); return; }
  if (req.method === 'GET' && url.pathname === '/auth/microsoft/start') { handleAuthStart('microsoft', res); return; }
  if (req.method === 'GET' && url.pathname === '/oauth/google/callback') { handleOAuthCallback('google', query, res); return; }
  if (req.method === 'GET' && url.pathname === '/oauth/microsoft/callback') { handleOAuthCallback('microsoft', query, res); return; }
  if (req.method === 'POST' && url.pathname === '/api/signout/google') { handleSignOut('google', res); return; }
  if (req.method === 'POST' && url.pathname === '/api/signout/microsoft') { handleSignOut('microsoft', res); return; }

  sendHtml(res, 404, '<h1>Not found</h1>');
});

server.listen(PORT, HOST, () => {
  console.log(`Command Center running at http://${HOST}:${PORT}/ (127.0.0.1 only)`);
  for (const provider of ['google', 'microsoft']) {
    const cfg = provider === 'google' ? loadGoogleConfig() : loadMicrosoftConfig();
    cache[provider].status = cfg ? 'loading' : 'not_configured';
  }
  refreshAccountCache('google');
  refreshAccountCache('microsoft');
  openBrowser(`http://${HOST}:${PORT}/`);
});
