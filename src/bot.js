import {
  ADMIN_TELEGRAM_ID,
  MIN_WITHDRAWAL,
  UNIT,
  addSupportMessage,
  getActivity,
  getAdminStats,
  getOrCreateUser,
  getReferralSummary,
  getUserByTelegramId,
  getUserSummary,
  listTasks,
  publicUser,
} from './users.js';
import { kvGet, kvSet } from './db.js';

const MENU = {
  home: '🏠 Home',
  balance: '💰 Balance',
  profile: '👤 Profile',
  connect: '🔗 Connect Wallet',
  walletinfo: '📊 Wallet Information',
  help: '🆘 Help',
};

const KEYBOARD = {
  keyboard: [
    [{ text: MENU.home }, { text: MENU.balance }],
    [{ text: MENU.profile }, { text: MENU.connect }],
    [{ text: MENU.walletinfo }, { text: MENU.help }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const WALLET_SECURITY_TEXT = [
  '🔐 <b>Secure wallet connection</b>',
  '',
  'COINVERA links to your wallet in <b>read-only</b> mode. Here is exactly how it works:',
  '',
  '1️⃣ Open your own wallet app and copy your <b>public wallet address</b> — the one that starts with <code>0x…</code>, <code>EQ…</code>, <code>UQ…</code> or <code>T…</code>.',
  '',
  '2️⃣ Paste that address into COINVERA. A public address is safe to share: it works like an account number and can only <i>receive</i> funds.',
  '',
  '3️⃣ COINVERA stores only that address, so your Active rewards are linked to you and payout requests reach the right wallet.',
  '',
  '4️⃣ No transaction can be signed from COINVERA, and you can disconnect the address at any time from <b>Wallet → Disconnect</b>.',
  '',
  '🚫 <b>COINVERA never stores or requests:</b>',
  '• your private key',
  '• your wallet password or PIN',
  '• your recovery phrase (12 or 24 words)',
  '',
  'Anyone who asks for those is trying to take your funds — even if they claim to be COINVERA support. Never type them into a chat, a bot or a website.',
].join('\n');

const WALLET_CONTINUE_TEXT = [
  '✅ <b>How to connect safely — step by step</b>',
  '',
  '<b>Step 1 · Find your public address</b>',
  'Open your wallet app (Trust Wallet, MetaMask, Tonkeeper, Ledger and so on), choose the account you want to use, tap <b>Receive</b> and copy the address shown. That string is public information.',
  '',
  '<b>Step 2 · Add it to COINVERA</b>',
  'Open the Mini App → <b>Wallet</b> → paste the address → <b>Connect wallet</b>. The address is validated and stored against your Telegram account only.',
  '',
  '<b>Step 3 · Confirm it is yours</b>',
  'Check the last 4 characters of the stored address against your wallet app. If they differ, remove it and paste again.',
  '',
  '<b>Step 4 · Keep control</b>',
  'Your keys stay in your wallet, on your device, forever. COINVERA cannot move, freeze or spend anything. Disconnect whenever you like.',
  '',
  '⚠️ <b>Three rules that protect you</b>',
  '1. A real wallet connection never asks you to type a recovery phrase into a chat or website.',
  '2. Never sign a transaction you did not start yourself.',
  '3. Nobody from COINVERA will ever message you first asking for keys, codes or a “validation” payment.',
  '',
  `ℹ️ <b>About Active:</b> Active is your COINVERA reward balance. It is a reward unit, not fiat currency. It becomes withdrawable once you meet the activity requirement, and payout requests are reviewed before they are sent to your connected wallet. The minimum request is ${MIN_WITHDRAWAL.toLocaleString('en-US')} ${UNIT}.`,
].join('\n');

const WELCOME_TEXT = [
  '👑 <b>Welcome to COINVERA</b>',
  '',
  'The premium rewards hub where your activity turns into real value.',
  '',
  'Your account is ready the moment you open the app:',
  '💰 <b>Active balance</b> credited on activation',
  '🎯 <b>Tasks</b> that pay Active Points',
  '🤝 <b>Referrals</b> with a personal invite code',
  '🔐 <b>Read-only wallet</b> linking — your keys never leave your wallet',
  '',
  'Tap the button below to open your dashboard.',
].join('\n');

export function createBot({ token, getWebAppUrl, log = console.log }) {
  const base = `https://api.telegram.org/bot${token}`;
  let offset = 0;
  let running = false;
  let botUsername = kvGet('bot_username') || null;
  let identityError = null;
  let lastRetryAfter = 0;
  let lastErrorCode = null;
  let rateLimitUntil = 0;
  let floodStrikes = 0;

  async function api(method, payload = {}, timeoutMs = 20000) {
    // Single gate shared by every caller: while Telegram is throttling this bot,
    // nothing may call the API early, or the flood window restarts.
    const gate = rateLimitUntil - Date.now();
    if (gate > 0) await sleep(gate);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({ ok: false }));
      lastRetryAfter = Number(data?.parameters?.retry_after) || 0;
      lastErrorCode = data?.error_code || null;
      if (data?.error_code === 429) {
        floodStrikes = Math.min(floodStrikes + 1, 6);
        const wait = Math.min(300, (lastRetryAfter || 3) * 2 ** (floodStrikes - 1));
        rateLimitUntil = Date.now() + wait * 1000;
        log(`[bot] flood wait ${wait}s (strike ${floodStrikes})`);
      } else if (data?.ok) {
        floodStrikes = 0;
      }
      if (!data.ok && data.error_code !== 409) {
        log(`[bot] ${method} failed: ${data.description || response.status}`);
      }
      return data;
    } catch (error) {
      const reason = error.name === 'AbortError' ? 'request timed out' : error.message;
      log(`[bot] ${method} network error: ${reason}`);
      // Distinguish transport failures from a token Telegram actually rejected.
      return { ok: false, description: `Network error contacting Telegram (${reason})`, network: true };
    } finally {
      clearTimeout(timer);
    }
  }

  const webAppUrl = () => getWebAppUrl();
  const webAppButton = (label = '🚀 OPEN COINVERA') => ({ inline_keyboard: [[{ text: label, web_app: { url: webAppUrl() } }]] });

  async function sendMessage(chatId, text, extra = {}) {
    return api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }

  async function ensureMenuButton(chatId) {
    const url = webAppUrl();
    if (!url.startsWith('https://')) return;
    await api('setChatMenuButton', {
      chat_id: chatId,
      menu_button: { type: 'web_app', text: 'COINVERA', web_app: { url } },
    });
  }

  async function register(profile, referralCode) {
    const result = getOrCreateUser(profile, { referralCode });
    if (result.isNew && ADMIN_TELEGRAM_ID) {
      const who = profile.username ? `@${profile.username}` : [profile.first_name, profile.last_name].filter(Boolean).join(' ');
      sendMessage(ADMIN_TELEGRAM_ID, [
        '🆕 <b>New COINVERA registration</b>',
        `User: ${escapeHtml(who || 'unknown')}`,
        `ID: <code>${escapeHtml(String(profile.id))}</code>`,
        `Bonus: <b>${result.bonus.toLocaleString('en-US')} ${UNIT}</b>`,
        `Referral code: <code>${result.user.referral_code}</code>`,
      ].join('\n')).catch(() => {});
    }
    return result;
  }

  function referralLink(code) {
    return botUsername
      ? `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`
      : `${webAppUrl()}?startapp=${encodeURIComponent(code)}`;
  }

  async function handleStart(message, payload) {
    const chatId = message.chat.id;
    const result = await register(message.from, payload || null);
    const user = result.user;

    await sendMessage(chatId, WELCOME_TEXT, { reply_markup: KEYBOARD });

    if (result.isNew) {
      await sendMessage(chatId, [
        '🎉 <b>Congratulations, your account is activated!</b>',
        '',
        `A welcome balance of <b>${result.bonus.toLocaleString('en-US')} ${UNIT}</b> has been added to your COINVERA account.`,
        '',
        `💎 Active balance: <b>${Number(user.active_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${UNIT}</b>`,
        `🆔 Telegram ID: <code>${escapeHtml(String(user.telegram_id))}</code>`,
        `🔑 Referral code: <code>${user.referral_code}</code>`,
        '',
        'Active is your reward balance: it becomes withdrawable once you meet the activity requirement, and payout requests are reviewed before they are sent to your connected wallet.',
        '',
        'Open COINVERA to explore tasks, referrals and your wallet.',
      ].join('\n'), { reply_markup: webAppButton() });
    } else {
      await sendMessage(chatId, [
        '👋 <b>Welcome back to COINVERA</b>',
        '',
        `💎 Active balance: <b>${Number(user.active_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${UNIT}</b>`,
        `⭐ Active Points: <b>${user.points.toLocaleString('en-US')}</b>`,
        `🔑 Referral code: <code>${user.referral_code}</code>`,
        '',
        'Your dashboard is one tap away.',
      ].join('\n'), { reply_markup: webAppButton() });
    }

    await ensureMenuButton(chatId);
  }

  async function handleHome(chatId, from) {
    const user = getUserByTelegramId(from.id);
    if (!user) return handleStart({ chat: { id: chatId }, from }, null);
    const summary = getUserSummary(user.id);
    const referrals = getReferralSummary(user.id);
    await sendMessage(chatId, [
      '🏠 <b>COINVERA Home</b>',
      '',
      `💎 Active balance: <b>${Number(user.active_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${UNIT}</b>`,
      `⭐ Active Points: <b>${user.points.toLocaleString('en-US')}</b>`,
      `🎯 Tasks completed: <b>${summary.tasksCompleted}</b>`,
      `🤝 Successful referrals: <b>${referrals.count}</b>`,
      `🔐 Wallet: ${user.wallet_address ? `<code>${shortAddress(user.wallet_address)}</code>` : '<i>not connected</i>'}`,
      '',
      'Open the dashboard for tasks, referrals and your wallet.',
    ].join('\n'), { reply_markup: webAppButton() });
  }

  async function handleBalance(chatId, from) {
    const user = getUserByTelegramId(from.id);
    if (!user) return handleStart({ chat: { id: chatId }, from }, null);
    const activity = getActivity(user.id, 5);
    const lines = [
      '💰 <b>Active Balance</b>',
      '',
      `<b>${Number(user.active_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${UNIT}</b>`,
      '',
      `⭐ Active Points: <b>${user.points.toLocaleString('en-US')}</b>`,
      `🔓 Withdrawable from: <b>${MIN_WITHDRAWAL.toLocaleString('en-US')} ${UNIT}</b>`,
      '',
      'Active is a COINVERA reward unit, not fiat currency. Withdrawal requests are reviewed and paid to your connected wallet.',
    ];
    if (activity.length) {
      lines.push('', '<b>Recent activity</b>');
      for (const item of activity) {
        lines.push(`• ${escapeHtml(item.title)}${item.amount ? ` — ${formatAmount(item)}` : ''}`);
      }
    }
    await sendMessage(chatId, lines.join('\n'), { reply_markup: webAppButton('💎 Open balance') });
  }

  async function handleProfile(chatId, from) {
    const user = getUserByTelegramId(from.id);
    if (!user) return handleStart({ chat: { id: chatId }, from }, null);
    await sendMessage(chatId, [
      '👤 <b>Your COINVERA profile</b>',
      '',
      `Name: <b>${escapeHtml([user.first_name, user.last_name].filter(Boolean).join(' ') || '—')}</b>`,
      `Username: ${user.username ? `@${escapeHtml(user.username)}` : '<i>not set</i>'}`,
      `Telegram ID: <code>${escapeHtml(String(user.telegram_id))}</code>`,
      `Status: <b>${user.is_admin ? 'Admin' : 'Active'}</b>`,
      `Joined: ${new Date(user.created_at).toUTCString()}`,
      '',
      `🔑 Referral code: <code>${user.referral_code}</code>`,
      `🔗 Invite link: ${escapeHtml(referralLink(user.referral_code))}`,
      `🔐 Wallet: ${user.wallet_address ? `<code>${escapeHtml(user.wallet_address)}</code>` : '<i>not connected</i>'}`,
      '',
      'Everything is stored against your Telegram ID, so your balance follows you across devices.',
    ].join('\n'), { reply_markup: webAppButton('👤 Open profile') });
  }

  async function handleWalletInformation(chatId) {
    await sendMessage(chatId, [
      '📊 <b>Wallet Information</b>',
      '',
      '<b>What COINVERA stores</b>',
      '• your public wallet address',
      '• the network it belongs to',
      '• the date you linked it',
      '',
      '<b>What COINVERA never stores</b>',
      '• private keys',
      '• passwords, PINs or 2FA codes',
      '• recovery phrases',
      '• any ability to sign transactions for you',
      '',
      '<b>What your address can and cannot do</b>',
      'A public address can receive funds and be looked up on a block explorer. It cannot move funds. Sharing it is like sharing an account number, not a password.',
      '',
      '<b>Removing it</b>',
      'Open the Mini App → Wallet → Disconnect. The address is deleted immediately and your balance stays untouched.',
      '',
      '<b>Verify before you trust</b>',
      'Compare the last 4 characters of the stored address with your wallet app. If anything differs, disconnect and link again.',
      '',
      '⚠️ No COINVERA process will ever ask for a private key or recovery phrase. Treat any such request as theft.',
    ].join('\n'), { reply_markup: webAppButton('📊 Open wallet page') });
  }

  async function handleConnectWallet(chatId) {
    await sendMessage(chatId, WALLET_SECURITY_TEXT, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Continue', callback_data: 'wallet:continue' }]] },
    });
  }

  async function handleWalletContinue(chatId, callbackId) {
    await api('answerCallbackQuery', { callback_query_id: callbackId, text: 'Here is how a secure connection works' });
    await sendMessage(chatId, WALLET_CONTINUE_TEXT, { reply_markup: webAppButton('🔐 Open wallet page') });
  }

  async function handleHelp(chatId) {
    await sendMessage(chatId, [
      '🆘 <b>Help & Support</b>',
      '',
      '<b>Menu</b>',
      '🏠 Home — balance snapshot and shortcuts',
      '💰 Balance — Active balance and recent activity',
      '👤 Profile — your account and referral code',
      '🔗 Connect Wallet — how read-only linking works',
      '📊 Wallet Information — what is stored and what is not',
      '',
      '<b>Need a human?</b>',
      'Send any message here and it is filed as a support ticket. The COINVERA team replies inside Telegram.',
      '',
      '<b>Common questions</b>',
      `• Active is a reward unit, not fiat currency, and becomes withdrawable from ${MIN_WITHDRAWAL.toLocaleString('en-US')} ${UNIT}.`,
      '• Tasks pay Active Points once each — duplicate claims are blocked automatically.',
      '• Referral rewards are credited only for genuinely new Telegram accounts.',
      '',
      '⚠️ Support will never ask for your private key, password or recovery phrase.',
    ].join('\n'), { reply_markup: webAppButton('🆘 Open help') });
  }

  async function handleAdmin(chatId, from) {
    const user = getUserByTelegramId(from.id);
    if (!user || !user.is_admin) {
      await sendMessage(chatId, '⛔ This area is reserved for COINVERA administrators.');
      return;
    }
    const stats = getAdminStats();
    await sendMessage(chatId, [
      '🛡 <b>COINVERA Admin</b>',
      '',
      `👥 Total users: <b>${stats.totalUsers}</b>`,
      `🆕 Registrations today: <b>${stats.registrationsToday}</b>`,
      `🎯 Tasks completed: <b>${stats.tasksCompleted}</b>`,
      `🤝 Referrals: <b>${stats.totalReferrals}</b>`,
      `🎁 Reward events: <b>${stats.rewardsIssued}</b>`,
      `⭐ Points issued: <b>${stats.rewardPointsIssued.toLocaleString('en-US')}</b>`,
      `💬 Support messages: <b>${stats.supportMessages}</b> (open: ${stats.openSupportMessages})`,
      `💸 Pending withdrawals: <b>${stats.pendingWithdrawals}</b> — ${stats.pendingWithdrawalAmount.toLocaleString('en-US')} ${UNIT}`,
      `💎 Active held by users: <b>${stats.totalActiveBalance.toLocaleString('en-US')}</b> ${UNIT}`,
      '',
      'Full tables are in the Mini App under Admin.',
    ].join('\n'), { reply_markup: webAppButton('🛡 Open admin') });
  }

  async function routeMenu(chatId, from, text) {
    const normalized = normalize(text);
    if (normalized === 'home' || normalized === 'start' || normalized === 'menu') return handleHome(chatId, from);
    if (normalized === 'balance') return handleBalance(chatId, from);
    if (normalized === 'profile') return handleProfile(chatId, from);
    if (normalized === 'connect wallet' || normalized === 'connect' || normalized === 'wallet') return handleConnectWallet(chatId);
    if (normalized === 'wallet information' || normalized === 'wallet info') return handleWalletInformation(chatId);
    if (normalized === 'help' || normalized === 'support') return handleHelp(chatId);
    if (normalized === 'admin' || normalized === 'dashboard') return handleAdmin(chatId, from);
    return null;
  }

  async function handleMessage(message) {
    const chatId = message.chat.id;
    const from = message.from;
    if (!from) return;

    if (message.chat.type !== 'private') {
      if (message.text && message.text.startsWith('/start')) {
        await sendMessage(chatId, 'Open COINVERA in a private chat with the bot so your account stays private.');
      }
      return;
    }

    const text = (message.text || '').trim();

    if (text.startsWith('/start')) {
      const payload = text.split(/\s+/)[1] || null;
      await handleStart(message, payload);
      return;
    }

    if (text.startsWith('/')) {
      const command = text.split(/\s+/)[0].slice(1).split('@')[0].toLowerCase();
      const handled = await routeMenu(chatId, from, command);
      if (handled) return;
      if (command === 'admin') return handleAdmin(chatId, from);
      await sendMessage(chatId, 'Use the menu buttons below, or tap OPEN COINVERA to launch the app.', { reply_markup: KEYBOARD });
      return;
    }

    const handled = await routeMenu(chatId, from, text);
    if (handled) return;

    if (text) {
      const user = getUserByTelegramId(from.id) || (await register(from, null)).user;
      addSupportMessage(user.id, text);
      if (ADMIN_TELEGRAM_ID) {
        sendMessage(ADMIN_TELEGRAM_ID, [
          '💬 <b>New support message</b>',
          `From: ${from.username ? `@${escapeHtml(from.username)}` : escapeHtml(from.first_name || 'user')} (<code>${escapeHtml(String(from.id))}</code>)`,
          '',
          escapeHtml(text.slice(0, 1500)),
        ].join('\n')).catch(() => {});
      }
      await sendMessage(chatId, '✅ <b>Message received</b>\n\nYour message is filed with the COINVERA support team. We reply here in Telegram.\n\n⚠️ Never send private keys, passwords or recovery phrases — support will never ask for them.', { reply_markup: KEYBOARD });
    }
  }

  async function handleCallback(query) {
    const chatId = query.message?.chat?.id;
    const data = query.data || '';
    if (!chatId) return;
    if (data === 'wallet:continue') return handleWalletContinue(chatId, query.id);
    if (data === 'wallet:info') return handleWalletInformation(chatId);
    if (data === 'menu:home') return handleHome(chatId, query.from);
    if (data === 'menu:balance') return handleBalance(chatId, query.from);
    await api('answerCallbackQuery', { callback_query_id: query.id });
  }

  async function handleUpdate(update) {
    if (update.message) return handleMessage(update.message);
    if (update.callback_query) return handleCallback(update.callback_query);
    return undefined;
  }

  async function loadIdentity() {
    const commands = [
      { command: 'start', description: 'Open COINVERA' },
      { command: 'home', description: 'Home dashboard' },
      { command: 'balance', description: 'Active balance' },
      { command: 'profile', description: 'Your profile' },
      { command: 'connect', description: 'Connect wallet securely' },
      { command: 'help', description: 'Help and support' },
    ];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const me = await api('getMe', {});
      if (me.ok && me.result?.username) {
        botUsername = me.result.username;
        identityError = null;
        kvSet('bot_username', botUsername);
        log(`[bot] token accepted by Telegram as @${botUsername}`);
        await api('setMyCommands', { commands });
        return true;
      }
      identityError = me.description || 'Telegram rejected the bot token (getMe failed)';
      log(`[bot] identity check failed (attempt ${attempt}): ${identityError}`);
      // A rejected token never becomes valid, so stop instead of hammering Telegram.
      if (me.error_code === 401 || me.error_code === 404) return false;
    }
    return false;
  }

  async function start() {
    running = true;
    while (running) {
      if (!botUsername || identityError) {
        const ok = await loadIdentity();
        if (!ok) {
          if (lastErrorCode === 401 || lastErrorCode === 404) {
            log('[bot] Telegram rejected this token — polling disabled until a valid BOT_TOKEN is saved');
            return;
          }
          // api() already waited out the flood window; retry the identity instead
          // of polling, so we never add extra requests while throttled.
          continue;
        }
        log(`[bot] polling started as @${botUsername}`);
      }
      const response = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
      if (!response.ok) {
        await sleep(lastErrorCode === 429 ? 1000 : 4000);
        continue;
      }
      for (const update of response.result || []) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          log(`[bot] handler error: ${error.message}`);
        }
      }
    }
  }

  function stop() {
    running = false;
  }

  function getStatus() {
    return { polling: running, username: botUsername, error: identityError, errorCode: lastErrorCode };
  }

  return { start, stop, api, handleUpdate, getBotUsername: () => botUsername, getStatus };
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalize(text) {
  return String(text || '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatAmount(item) {
  return `+${Number(item.amount).toLocaleString('en-US')} ${item.unit}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
