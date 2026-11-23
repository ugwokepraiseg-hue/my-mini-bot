import crypto from 'node:crypto';
import { db, nowIso, transaction } from './db.js';

export const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || '8463629333');
export const SIGNUP_MIN = 5000;
export const SIGNUP_MAX = 10000;
export const REFERRAL_REWARD_POINTS = 500;
export const MIN_WITHDRAWAL = 1000;
export const UNIT = 'ACTIVE';

function randomSignupBonus() {
  const steps = Math.floor((SIGNUP_MAX - SIGNUP_MIN) / 50);
  return SIGNUP_MIN + crypto.randomInt(0, steps + 1) * 50;
}

function makeReferralCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let code = 'CV';
    for (let index = 0; index < 5; index += 1) code += alphabet[crypto.randomInt(0, alphabet.length)];
    const taken = db.prepare('SELECT 1 AS found FROM users WHERE referral_code = ?').get(code);
    if (!taken) return code;
  }
  return `CV${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function getUserByTelegramId(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId)) ?? null;
}

export function addActivity(userId, kind, title, amount, unit = UNIT) {
  db.prepare('INSERT INTO activities (user_id, kind, title, amount, unit, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, kind, title, amount, unit, nowIso());
}

export function publicUser(user) {
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ')
    || (user.username ? `@${user.username}` : 'COINVERA user');
  return {
    telegramId: user.telegram_id,
    username: user.username ?? null,
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
    displayName,
    activeBalance: Number(user.active_balance.toFixed(2)),
    points: user.points,
    referralCode: user.referral_code,
    walletAddress: user.wallet_address ?? null,
    walletNetwork: user.wallet_network ?? null,
    walletConnectedAt: user.wallet_connected_at ?? null,
    isAdmin: Boolean(user.is_admin),
    isPremium: Boolean(user.is_premium),
    joinedAt: user.created_at,
    lastSeenAt: user.last_seen_at,
    status: 'Active',
    unit: UNIT,
  };
}

/** Registers on first contact. The signup bonus can only ever be granted once per Telegram account. */
export function getOrCreateUser(profile, { referralCode = null, isAdmin = false } = {}) {
  const telegramId = String(profile.id);
  const existing = getUserByTelegramId(telegramId);

  if (existing) {
    db.prepare(`UPDATE users SET username = ?, first_name = ?, last_name = ?, language_code = ?, is_premium = ?, last_seen_at = ? WHERE id = ?`)
      .run(
        profile.username ?? existing.username ?? null,
        profile.first_name ?? existing.first_name ?? null,
        profile.last_name ?? existing.last_name ?? null,
        profile.language_code ?? existing.language_code ?? null,
        profile.is_premium ? 1 : 0,
        nowIso(),
        existing.id,
      );
    return { user: getUserById(existing.id), isNew: false, bonus: 0 };
  }

  return transaction(() => {
    const bonus = randomSignupBonus();
    const code = makeReferralCode();
    const now = nowIso();

    let referrer = null;
    if (referralCode) {
      referrer = db.prepare('SELECT * FROM users WHERE UPPER(referral_code) = UPPER(?)').get(String(referralCode).trim()) ?? null;
      if (referrer && String(referrer.telegram_id) === telegramId) referrer = null;
    }

    const isAdminUser = isAdmin || telegramId === ADMIN_TELEGRAM_ID ? 1 : 0;
    const info = db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, last_name, language_code, is_premium,
        referral_code, referred_by, active_balance, points, is_admin, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      telegramId,
      profile.username ?? null,
      profile.first_name ?? null,
      profile.last_name ?? null,
      profile.language_code ?? null,
      profile.is_premium ? 1 : 0,
      code,
      referrer ? referrer.id : null,
      bonus,
      isAdminUser,
      now,
      now,
    );

    const userId = Number(info.lastInsertRowid);
    addActivity(userId, 'signup_bonus', 'Account activated — welcome bonus', bonus, UNIT);

    if (referrer) {
      db.prepare('INSERT INTO referrals (referrer_id, referred_id, reward_points, created_at) VALUES (?, ?, ?, ?)')
        .run(referrer.id, userId, REFERRAL_REWARD_POINTS, now);
      db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(REFERRAL_REWARD_POINTS, referrer.id);
      addActivity(referrer.id, `referral_bonus:${userId}`, 'Referral bonus — friend joined', REFERRAL_REWARD_POINTS, 'POINTS');
    }

    return { user: getUserById(userId), isNew: true, bonus, referredBy: referrer ? referrer.id : null };
  });
}

export function listTasks(userId) {
  const rows = db.prepare(`
    SELECT t.*, tc.created_at AS completed_at
    FROM tasks t
    LEFT JOIN task_completions tc ON tc.task_id = t.id AND tc.user_id = ?
    WHERE t.active = 1
    ORDER BY t.sort_order ASC
  `).all(userId);
  return rows.map((task) => ({
    code: task.code,
    title: task.title,
    description: task.description,
    rewardPoints: task.reward_points,
    requirement: task.requirement,
    actionLabel: task.action_label,
    completed: Boolean(task.completed_at),
    completedAt: task.completed_at ?? null,
  }));
}

export function claimTask(userId, code) {
  const user = getUserById(userId);
  if (!user) return { ok: false, error: 'user_not_found' };

  const task = db.prepare('SELECT * FROM tasks WHERE code = ? AND active = 1').get(code);
  if (!task) return { ok: false, error: 'task_not_found' };

  const done = db.prepare('SELECT 1 AS found FROM task_completions WHERE user_id = ? AND task_id = ?').get(userId, task.id);
  if (done) return { ok: false, error: 'already_completed' };

  if (task.requirement === 'wallet' && !user.wallet_address) return { ok: false, error: 'requirement_wallet' };
  if (task.requirement === 'referral') {
    const referrals = db.prepare('SELECT COUNT(*) AS total FROM referrals WHERE referrer_id = ?').get(userId);
    if (!referrals.total) return { ok: false, error: 'requirement_referral' };
  }
  if (task.requirement === 'profile' && !(user.username || user.first_name)) return { ok: false, error: 'requirement_profile' };

  try {
    transaction(() => {
      db.prepare('INSERT INTO task_completions (user_id, task_id, reward_points, created_at) VALUES (?, ?, ?, ?)')
        .run(userId, task.id, task.reward_points, nowIso());
      db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(task.reward_points, userId);
      addActivity(userId, `task:${task.code}`, `Task reward — ${task.title}`, task.reward_points, 'POINTS');
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return { ok: false, error: 'already_completed' };
    throw error;
  }

  return { ok: true, points: task.reward_points, user: getUserById(userId) };
}

const EVM_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TON_PATTERN = /^(EQ|UQ)[A-Za-z0-9_-]{46}$/;
const TRON_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function describeAddress(address) {
  const value = String(address || '').trim();
  if (!value) return { ok: false, error: 'address_missing' };
  // Never accept secrets, even if a user pastes them by mistake.
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length >= 6) return { ok: false, error: 'looks_like_secret' };
  if (/^[0-9a-fA-F]{64}$/.test(value)) return { ok: false, error: 'looks_like_secret' };
  if (EVM_PATTERN.test(value)) return { ok: true, address: value, network: 'EVM' };
  if (TON_PATTERN.test(value)) return { ok: true, address: value, network: 'TON' };
  if (TRON_PATTERN.test(value)) return { ok: true, address: value, network: 'TRON' };
  return { ok: false, error: 'address_invalid' };
}

export function connectWallet(userId, { address, network }) {
  const parsed = describeAddress(address);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const user = getUserById(userId);
  if (!user) return { ok: false, error: 'user_not_found' };

  const now = nowIso();
  db.prepare('UPDATE users SET wallet_address = ?, wallet_network = ?, wallet_connected_at = ? WHERE id = ?')
    .run(parsed.address, network || parsed.network, now, userId);
  addActivity(userId, `wallet_connect:${Date.now()}`, 'Wallet linked (read-only)', 0, 'WALLET');

  return { ok: true, user: getUserById(userId) };
}

export function disconnectWallet(userId) {
  db.prepare('UPDATE users SET wallet_address = NULL, wallet_network = NULL, wallet_connected_at = NULL WHERE id = ?').run(userId);
  addActivity(userId, `wallet_disconnect:${Date.now()}`, 'Wallet disconnected', 0, 'WALLET');
  return { ok: true, user: getUserById(userId) };
}

export function getActivity(userId, limit = 40) {
  return db.prepare('SELECT * FROM activities WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    amount: row.amount,
    unit: row.unit,
    createdAt: row.created_at,
  }));
}

export function getReferralSummary(userId) {
  const items = db.prepare(`
    SELECT r.created_at, r.reward_points, u.username, u.first_name, u.telegram_id
    FROM referrals r JOIN users u ON u.id = r.referred_id
    WHERE r.referrer_id = ?
    ORDER BY r.id DESC
  `).all(userId).map((row) => ({
    username: row.username ?? null,
    name: row.first_name ?? 'COINVERA user',
    joinedAt: row.created_at,
    rewardPoints: row.reward_points,
  }));

  const total = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(reward_points), 0) AS points FROM referrals WHERE referrer_id = ?').get(userId);
  return { count: total.total, pointsEarned: total.points, items };
}

export function getUserSummary(userId) {
  const tasks = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(reward_points), 0) AS points FROM task_completions WHERE user_id = ?').get(userId);
  return { tasksCompleted: tasks.total, taskPoints: tasks.points };
}

export function addSupportMessage(userId, message) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: 'message_empty' };
  if (text.length > 2000) return { ok: false, error: 'message_too_long' };
  db.prepare('INSERT INTO support_messages (user_id, message, status, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, text, 'open', nowIso());
  return { ok: true };
}

export function requestWithdrawal(userId, { amount, address, network }) {
  const user = getUserById(userId);
  if (!user) return { ok: false, error: 'user_not_found' };

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'amount_invalid' };
  if (value < MIN_WITHDRAWAL) return { ok: false, error: 'amount_below_minimum' };
  if (value > user.active_balance) return { ok: false, error: 'insufficient_balance' };

  const target = String(address || user.wallet_address || '').trim();
  const parsed = describeAddress(target);
  if (!parsed.ok) return { ok: false, error: parsed.error === 'address_missing' ? 'wallet_required' : parsed.error };

  transaction(() => {
    db.prepare('INSERT INTO withdrawals (user_id, amount, address, network, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, value, parsed.address, network || parsed.network, 'pending', nowIso());
    db.prepare('UPDATE users SET active_balance = active_balance - ? WHERE id = ?').run(value, userId);
    addActivity(userId, `withdrawal:${Date.now()}`, 'Withdrawal request submitted', value, UNIT);
  });

  return { ok: true, user: getUserById(userId) };
}

export function getAdminStats() {
  const users = db.prepare('SELECT COUNT(*) AS total FROM users').get();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const registrationsToday = db.prepare('SELECT COUNT(*) AS total FROM users WHERE created_at >= ?').get(today.toISOString());
  const tasks = db.prepare('SELECT COUNT(*) AS total FROM task_completions').get();
  const referrals = db.prepare('SELECT COUNT(*) AS total FROM referrals').get();
  const rewards = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(amount), 0) AS sum FROM activities WHERE unit = 'POINTS'`).get();
  const support = db.prepare('SELECT COUNT(*) AS total FROM support_messages').get();
  const supportOpen = db.prepare(`SELECT COUNT(*) AS total FROM support_messages WHERE status = 'open'`).get();
  const withdrawals = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(amount), 0) AS sum FROM withdrawals WHERE status = 'pending'`).get();
  const balances = db.prepare('SELECT COALESCE(SUM(active_balance), 0) AS active, COALESCE(SUM(points), 0) AS points FROM users').get();

  const recentUsers = db.prepare('SELECT telegram_id, username, first_name, active_balance, points, referral_code, created_at FROM users ORDER BY id DESC LIMIT 10').all()
    .map((row) => ({
      telegramId: row.telegram_id,
      username: row.username,
      name: row.first_name ?? 'COINVERA user',
      activeBalance: Number(row.active_balance.toFixed(2)),
      points: row.points,
      referralCode: row.referral_code,
      joinedAt: row.created_at,
    }));

  const supportItems = db.prepare(`
    SELECT s.id, s.message, s.status, s.created_at, u.telegram_id, u.username, u.first_name
    FROM support_messages s JOIN users u ON u.id = s.user_id
    ORDER BY s.id DESC LIMIT 10
  `).all().map((row) => ({
    id: row.id,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    telegramId: row.telegram_id,
    username: row.username,
    name: row.first_name ?? 'COINVERA user',
  }));

  const withdrawalItems = db.prepare(`
    SELECT w.id, w.amount, w.address, w.network, w.status, w.created_at, u.telegram_id, u.username
    FROM withdrawals w JOIN users u ON u.id = w.user_id
    ORDER BY w.id DESC LIMIT 10
  `).all().map((row) => ({
    id: row.id,
    amount: Number(row.amount.toFixed(2)),
    address: row.address,
    network: row.network,
    status: row.status,
    createdAt: row.created_at,
    telegramId: row.telegram_id,
    username: row.username,
  }));

  return {
    totalUsers: users.total,
    registrationsToday: registrationsToday.total,
    tasksCompleted: tasks.total,
    totalReferrals: referrals.total,
    rewardsIssued: rewards.total,
    rewardPointsIssued: rewards.sum,
    supportMessages: support.total,
    openSupportMessages: supportOpen.total,
    pendingWithdrawals: withdrawals.total,
    pendingWithdrawalAmount: Number(withdrawals.sum.toFixed(2)),
    totalActiveBalance: Number(balances.active.toFixed(2)),
    totalPoints: balances.points,
    recentUsers,
    supportItems,
    withdrawalItems,
  };
}

export function isAdminUser(user) {
  return Boolean(user && (user.is_admin || String(user.telegram_id) === ADMIN_TELEGRAM_ID));
}
