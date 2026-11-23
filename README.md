# COINVERA

A complete Telegram bot + Telegram Mini App for a rewards program, built on a
zero-dependency Node server with SQLite persistence.

- **Bot** — welcome message, `OPEN COINVERA` Mini App button, persistent menu
  (Home, Balance, Profile, Connect Wallet, Wallet Information, Help), referral
  links, admin commands.
- **Mini App** — premium black / emerald / gold interface, Android-first,
  safe-area aware, with home dashboard, balance, tasks, referrals, activity,
  profile, wallet, help and an admin dashboard.
- **Backend** — SQLite database, Telegram `initData` HMAC verification, no
  secrets in source.

## Quick start

```bash
cp .env.example .env          # add your BotFather token
npm start                     # http://localhost:3000
```

The app runs in **preview mode** when `BOT_TOKEN` is empty: it renders the full
interface with a demo account and a visible banner, so you can review the design
before wiring the bot. Authentication is enforced as soon as `BOT_TOKEN` is set.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `BOT_TOKEN` | yes (live) | BotFather token. Also derives the Mini App signature key. |
| `ADMIN_TELEGRAM_ID` | no | Telegram ID allowed to open the admin dashboard. Defaults to `8463629333`. |
| `WEBAPP_URL` | no | Public https URL used by the `OPEN COINVERA` button. Falls back to the origin of the first request. |
| `PORT` | no | HTTP port, default `3000`. The server binds `0.0.0.0`. |
| `DATA_DIR` | no | SQLite location, default `./data`. |

Set these in **Settings → Environment variables** on AppJet. Never commit a
token; `.env` and the `data/` directory are git-ignored.

## Connecting the bot

1. Create the bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Add `BOT_TOKEN` to your environment variables and restart.
3. Give the bot a Mini App: in BotFather run `/newapp`, point it at your
   deployed https URL. The bot also opens the app through a `web_app` button,
   which works without a separate menu entry.
4. Optional: `/setcommands` → `start`, `home`, `balance`, `profile`, `wallet`,
   `help`, `admin`.

The Mini App must be served over **https** for Telegram to launch it.

## Features

**Account activation.** First contact from Telegram auto-registers the user with
their Telegram ID, username and name, assigns a unique referral code, and grants
a random welcome bonus between **5,000 and 10,000 Active**. A partial unique
index on the `signup_bonus` activity guarantees the bonus can never be granted
twice, even across restarts or replayed requests.

**Active balance.** "Active" is the reward unit stored per user. It is not fiat
currency: it is credited from the welcome bonus and spent on withdrawal requests,
which are recorded as `pending` and reviewed before payout.

**Tasks and rewards.** Tasks are seeded in `src/db.js`. Each task pays once,
enforced by `UNIQUE(user_id, task_id)`. Requirements (`wallet`, `referral`,
`profile`) are checked server-side before points are credited.

**Referrals.** Every user gets a `CVxxxxx` code. The Mini App offers copy and a
native Telegram share sheet. A referral is recorded only for a genuinely new
Telegram account, and self-referral is rejected.

**Wallet connection — read-only by design.** COINVERA links a **public address**
plus a network label. The server validates the address format (EVM, TON, TRON),
stores nothing else, and explicitly rejects private-key-shaped input and
12/24-word phrases with `looks_like_secret`. An address can receive funds and be
inspected on a block explorer; it cannot move funds.

> COINVERA never asks for a private key, password or recovery phrase. In the bot,
> **Connect Wallet** explains how a secure read-only connection works, offers
> **Continue**, and then returns a written explanation of the process and the
> safety rules. It never requests a key or phrase.

**Admin dashboard.** Visible to `ADMIN_TELEGRAM_ID` only, both in the Mini App and
via the bot's `/admin` command: total users, registrations today, tasks
completed, referrals, rewards issued, support messages, pending withdrawals and
aggregate balances.

## API

All endpoints except `/api/health` require the Telegram signature header
`X-Telegram-Init-Data` (the raw `initData` string from the Mini App).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness, bot configuration, unit |
| GET | `/api/session` | Registers/loads the user and returns the full dashboard payload |
| POST | `/api/tasks/claim` | Claims a task (`{code}`), blocked on duplicates |
| POST | `/api/wallet/connect` | Links a public address (`{address, network}`) |
| POST | `/api/wallet/disconnect` | Removes the linked address |
| POST | `/api/support` | Stores a support message (`{message}`) |
| POST | `/api/withdrawal` | Creates a pending withdrawal (`{amount, address}`) |
| GET | `/api/admin` | Admin statistics (admin only) |

## Security model

- `initData` is verified with HMAC-SHA256 using
  `secret = HMAC_SHA256("WebAppData", BOT_TOKEN)`, a constant-time comparison,
  and a 24-hour `auth_date` freshness window.
- No endpoint trusts a client-supplied Telegram ID.
- All balances, points and referral credits are computed server-side inside
  transactions; duplicate rewards are prevented by database constraints.
- Secrets come from environment variables only, and are never logged or returned.

## Tests

```bash
npm test        # requires Node >= 22.5 (built-in node:sqlite)
```

`scripts/smoke-test.js` boots the real server against a temporary database and
checks registration, the signup-bonus duplicate guard, task claiming and
duplicate rejection, requirement gating, address validation, secret rejection,
wallet link/unlink, withdrawal limits, support messages, admin counters and
static asset serving.

## Project layout

```
server.js            HTTP server, routing, auth middleware, static files
src/db.js            SQLite schema, task seed, transactions
src/auth.js          Telegram initData verification
src/users.js         Registration, balances, tasks, referrals, wallet, admin
src/bot.js           Bot API client, commands, keyboards, Connect Wallet flow
public/              Mini App (index.html, styles.css, app.js)
scripts/smoke-test.js
Dockerfile           node:26-alpine, non-root
```

## Deployment notes

The container runs as a non-root user and listens on `0.0.0.0:$PORT`. SQLite data
lives in `DATA_DIR`; on hosts without a persistent disk that directory is
temporary, so attach a persistent disk (Starter plan or higher) if you need
balances to survive redeploys.
