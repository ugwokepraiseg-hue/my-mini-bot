import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'coinvera.db');
export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  is_premium INTEGER NOT NULL DEFAULT 0,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by INTEGER,
  active_balance REAL NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  wallet_address TEXT,
  wallet_network TEXT,
  wallet_connected_at TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_bonus_once
  ON activities(user_id, kind) WHERE kind = 'signup_bonus';

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reward_points INTEGER NOT NULL DEFAULT 0,
  requirement TEXT NOT NULL DEFAULT 'none',
  action_url TEXT,
  action_label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  reward_points INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, task_id)
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL,
  referred_id INTEGER NOT NULL UNIQUE,
  reward_points INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  address TEXT NOT NULL,
  network TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const TASK_SEED = [
  {
    code: 'join_channel',
    title: 'Join the COINVERA channel',
    description: 'Follow official announcements so you never miss a reward drop.',
    reward_points: 250,
    requirement: 'none',
    action_label: 'Open channel',
    sort_order: 1,
  },
  {
    code: 'connect_wallet',
    title: 'Link your wallet in the bot',
    description: 'Wallet linking is done only in the Telegram bot. Tap 🔐 Connect Wallet there to link a public address so Active rewards can reach you.',
    reward_points: 500,
    requirement: 'wallet',
    action_label: 'Claim reward',
    sort_order: 2,
  },
  {
    code: 'invite_friend',
    title: 'Invite your first friend',
    description: 'Share your referral code and earn when a friend joins COINVERA.',
    reward_points: 750,
    requirement: 'referral',
    action_label: 'Open invite page',
    sort_order: 3,
  },
  {
    code: 'read_guide',
    title: 'Read the COINVERA guide',
    description: 'Learn how Active balance, rewards and payouts work.',
    reward_points: 150,
    requirement: 'none',
    action_label: 'Read guide',
    sort_order: 4,
  },
  {
    code: 'complete_profile',
    title: 'Complete your profile',
    description: 'Keep your Telegram profile visible so referrals can reach you.',
    reward_points: 200,
    requirement: 'profile',
    action_label: 'Open profile',
    sort_order: 5,
  },
];

const insertTask = db.prepare(`
  INSERT INTO tasks (code, title, description, reward_points, requirement, action_url, action_label, active, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(code) DO UPDATE SET
    title = excluded.title,
    description = excluded.description,
    reward_points = excluded.reward_points,
    requirement = excluded.requirement,
    action_label = excluded.action_label,
    sort_order = excluded.sort_order
`);

for (const task of TASK_SEED) {
  insertTask.run(
    task.code,
    task.title,
    task.description,
    task.reward_points,
    task.requirement,
    task.action_url ?? null,
    task.action_label ?? null,
    task.sort_order,
  );
}

export const nowIso = () => new Date().toISOString();

export function kvGet(key) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}
