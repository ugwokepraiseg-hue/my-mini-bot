import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInitData } from './src/auth.js';
import { kvGet, kvSet } from './src/db.js';
import { createBot } from './src/bot.js';
import {
  ADMIN_TELEGRAM_ID,
  MIN_WITHDRAWAL,
  UNIT,
  addSupportMessage,
  claimTask,
  connectWallet,
  disconnectWallet,
  getActivity,
  getAdminStats,
  getOrCreateUser,
  getReferralSummary,
  getUserById,
  getUserSummary,
  isAdminUser,
  listTasks,
  publicUser,
  requestWithdrawal,
} from './src/users.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const BOT_TOKEN = String(
  process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '',
).trim();
const PREVIEW_MODE = !BOT_TOKEN;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function publicOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!host) return null;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(host)) return null;
  // Telegram refuses to open a Mini App over http://, and the platform terminates
  // TLS in front of us, so a public host is always advertised as https.
  return `https://${host}`;
}

// Last-resort public address: a fresh database has not seen a request yet, and a
// web_app button pointing at localhost is exactly what makes Telegram refuse to
// open the Mini App. Override it with WEBAPP_URL (or PUBLIC_URL) at any time.
const DEFAULT_WEBAPP_URL = 'https://to8bdtjvqf.dev.onappjet.com';

function getWebAppUrl() {
  const configured = (process.env.WEBAPP_URL || process.env.PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const observed = kvGet('public_origin');
  if (observed && observed.startsWith('https://')) return observed.replace(/\/+$/, '');
  return DEFAULT_WEBAPP_URL;
}

function rememberOrigin(req) {
  const origin = publicOrigin(req);
  if (!origin) return;
  if (kvGet('public_origin') !== origin) kvSet('public_origin', origin);
}

function referralLink(code) {
  const username = kvGet('bot_username');
  if (username) return `https://t.me/${username}?start=${encodeURIComponent(code)}`;
  return `${getWebAppUrl()}?startapp=${encodeURIComponent(code)}`;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

const GUEST_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function resolveIdentity(req, url) {
  const initData = String(req.headers['x-telegram-init-data'] || url.searchParams.get('initData') || '');
  const guestKey = String(req.headers['x-coinvera-guest'] || url.searchParams.get('guest') || '');
  const guest = GUEST_PATTERN.test(guestKey);

  if (BOT_TOKEN) {
    const result = initData ? verifyInitData(initData, BOT_TOKEN) : { ok: false, error: 'init_data_missing' };
    if (result.ok) {
      return { ok: true, profile: result.user, startParam: result.startParam, preview: false, guest: false };
    }
    if (!guest) {
      return {
        ok: false,
        error: result.error,
        initDataLength: initData.length,
        diagnostics: result.diagnostics || null,
      };
    }
  }

  // Fallback: a device-scoped guest account. Guest ids live in their own
  // `guest:` namespace, so they can never collide with a real Telegram id and
  // can never be treated as an admin.
  if (guest) {
    return {
      ok: true,
      preview: false,
      guest: true,
      startParam: url.searchParams.get('startapp'),
      profile: {
        id: `guest:${guestKey}`,
        first_name: 'Guest',
        last_name: 'User',
        username: null,
        language_code: 'en',
      },
    };
  }
  return {
    ok: true,
    preview: true,
    guest: false,
    startParam: url.searchParams.get('startapp'),
    profile: {
      id: '0',
      first_name: 'Preview',
      last_name: 'User',
      username: 'coinvera_preview',
      language_code: 'en',
    },
  };
}

function requireUser(req, url, res) {
  const identity = resolveIdentity(req, url);
  if (!identity.ok) {
    console.warn(
      `[auth] rejected reason=${identity.error} initDataLen=${identity.initDataLength || 0}` +
        ` fields=${(identity.diagnostics?.fields || []).join(',') || '-'}` +
        ` hasSignature=${Boolean(identity.diagnostics?.hasSignature)}`,
    );
    sendJson(res, 401, {
      ok: false,
      error: identity.error,
      initDataPresent: (identity.initDataLength || 0) > 0,
      diagnostics: identity.diagnostics || null,
      message:
        identity.error === 'init_data_missing'
          ? 'Open COINVERA from inside Telegram so your account can be verified.'
          : 'Telegram sign-in could not be verified. Close the app and open it again from the bot button.',
    });
    return null;
  }
  const { user } = getOrCreateUser(identity.profile, {
    referralCode: identity.startParam,
    isAdmin: identity.preview,
  });
  return { user, preview: identity.preview, guest: Boolean(identity.guest) };
}

function sessionPayload(user, preview) {
  const summary = getUserSummary(user.id);
  const referrals = getReferralSummary(user.id);
  return {
    ok: true,
    preview,
    guest: String(user.telegram_id).startsWith('guest:'),
    user: publicUser(user),
    tasks: listTasks(user.id),
    activity: getActivity(user.id, 30),
    referrals: {
      ...referrals,
      code: user.referral_code,
      link: referralLink(user.referral_code),
    },
    summary,
    config: {
      unit: UNIT,
      minWithdrawal: MIN_WITHDRAWAL,
      botUsername: kvGet('bot_username'),
      preview,
      adminTelegramId: ADMIN_TELEGRAM_ID,
    },
    admin: isAdminUser(user) ? getAdminStats() : null,
  };
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/health') {
    return sendJson(res, 200, {
      ok: true,
      botConfigured: Boolean(BOT_TOKEN),
      preview: PREVIEW_MODE,
      unit: UNIT,
      webAppUrl: getWebAppUrl(),
      bot: bot ? bot.getStatus() : { polling: false, username: null, error: null },
      time: new Date().toISOString(),
    });
  }

  if (route === 'GET /api/session') {
    const auth = requireUser(req, url, res);
    if (!auth) return undefined;
    return sendJson(res, 200, sessionPayload(auth.user, auth.preview));
  }

  if (route === 'POST /api/tasks/claim') {
    const auth = requireUser(req, url, res);
    if (!auth) return undefined;
    const body = await readJson(req);
    const result = claimTask(auth.user.id, String(body.code || ''));
    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error, ...sessionPayload(auth.user, auth.preview) });
    return sendJson(res, 200, { ok: true, awarded: result.points, ...sessionPayload(result.user, auth.preview) });
  }

  if (route === 'POST /api/wallet/connect') {
    const auth = requireUser(req, url, res);
    if (!auth) return undefined;
    const body = await readJson(req);
    const result = connectWallet(auth.user.id, { address: body.address, network: body.network });
    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
    return sendJson(res, 200, { ok: true, ...sessionPayload(result.user, auth.preview) });
  }

  if (route === 'POST /api/wallet/disconnect') {
    const auth = requireUser(req, url, res);
    if (!auth) return undefined;
    const result = disconnectWallet(auth.user.id);
    return sendJson(res, 200, { ok: true, ...sessionPayload(result.user, auth.preview) });
  }

  if (route === 'POST /api/support') {
    const auth = requireUser(req, url, res);
    if (!auth) return undefined;
    const body = await readJson(req);
    const result = addSupportMessage(auth.user.id, body.message);
    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/withdrawal') {
    const auth = requireUser(req, url, res);
    if (!auth) return undefined;
    const body = await readJson(req);
    const result = requestWithdrawal(auth.user.id, {
      amount: body.amount,
      address: body.address,
      network: body.network,
    });
    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
    return sendJson(res, 200, { ok: true, ...sessionPayload(result.user, auth.preview) });
  }

  if (route === 'GET /api/admin') {
    const auth = requireUser(req, url, res);
    if (!auth) return undefined;
    if (!isAdminUser(auth.user)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    return sendJson(res, 200, { ok: true, admin: getAdminStats() });
  }

  return sendJson(res, 404, { ok: false, error: 'not_found' });
}

function serveStatic(req, res, urlPath) {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const decoded = decodeURIComponent(requested);
  const filePath = path.join(publicDir, path.normalize(decoded).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (!path.extname(decoded)) {
        fs.readFile(path.join(publicDir, 'index.html'), (fallbackError, fallback) => {
          if (fallbackError) {
            res.writeHead(404).end('Not found');
            return;
          }
          res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
          res.end(fallback);
        });
        return;
      }
      res.writeHead(404).end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  rememberOrigin(req);

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (error) {
      const status = error.message === 'payload_too_large' || error.message === 'invalid_json' ? 400 : 500;
      if (status === 500) console.error('[api] error', error);
      if (!res.headersSent) sendJson(res, status, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`[coinvera] listening on http://${HOST}:${PORT}`);
  console.log(`[coinvera] mode: ${PREVIEW_MODE ? 'preview (BOT_TOKEN not set)' : 'live'}`);
});

let bot = null;
if (BOT_TOKEN) {
  bot = createBot({ token: BOT_TOKEN, getWebAppUrl });
  bot.start().catch((error) => console.error('[bot] fatal', error.message || error));
} else {
  console.log('[coinvera] BOT_TOKEN not set — bot polling disabled, Mini App runs in preview mode');
}

function shutdown(signal) {
  console.log(`[coinvera] ${signal} received, shutting down`);
  if (bot) bot.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
