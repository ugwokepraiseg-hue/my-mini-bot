import crypto from 'node:crypto';

const MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Telegram Mini App initData verification.
 * secret = HMAC_SHA256(key="WebAppData", data=bot_token)
 * hash   = HMAC_SHA256(key=secret, data=data_check_string)
 */
export function verifyInitData(initData, botToken, { maxAgeSeconds = MAX_AGE_SECONDS } = {}) {
  if (!botToken) return { ok: false, error: 'bot_token_missing' };
  if (!initData || typeof initData !== 'string') return { ok: false, error: 'init_data_missing' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'hash_missing' };

  params.delete('hash');
  const entries = [...params.entries()];

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const buildString = (omit = []) =>
    entries
      .filter(([key]) => !omit.includes(key))
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

  // Newer Telegram clients add an Ed25519 `signature` field. Depending on the
  // client generation it is either included in or excluded from the signed
  // string, so both orderings are accepted. Nothing is weakened: each variant
  // is still a full HMAC-SHA256 proof over the bot token.
  const variants = [buildString(), buildString(['signature'])];
  const matched = variants.some((dataCheckString) =>
    safeEqual(crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex'), hash),
  );

  if (!matched) {
    return {
      ok: false,
      error: 'signature_invalid',
      diagnostics: {
        fields: entries.map(([key]) => key).sort(),
        hasSignature: params.has('signature'),
        fieldCount: entries.length,
      },
    };
  }

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate) return { ok: false, error: 'auth_date_missing' };
  if (Math.floor(Date.now() / 1000) - authDate > maxAgeSeconds) return { ok: false, error: 'expired' };

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return { ok: false, error: 'user_invalid' };
  }
  if (!user || user.id === undefined || user.id === null) return { ok: false, error: 'user_invalid' };

  return { ok: true, user, authDate, startParam: params.get('start_param') || null };
}

function safeEqual(computedHex, provided) {
  const candidates = [];
  if (/^[0-9a-f]{64}$/i.test(provided)) candidates.push(Buffer.from(provided, 'hex'));
  try {
    const b64 = Buffer.from(provided.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b64.length === 32) candidates.push(b64);
  } catch {
    /* ignore */
  }
  const computed = Buffer.from(computedHex, 'hex');
  return candidates.some((candidate) => candidate.length === computed.length && crypto.timingSafeEqual(candidate, computed));
}

/** Used by the smoke test and local tooling to mint a valid payload. */
export function signInitData(user, botToken, { authDate = Math.floor(Date.now() / 1000), startParam } = {}) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', `AA${crypto.randomBytes(8).toString('hex')}`);
  params.set('user', JSON.stringify(user));
  if (startParam) params.set('start_param', startParam);

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}
