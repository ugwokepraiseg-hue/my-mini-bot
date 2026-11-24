const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

const TABS = ['home', 'balance', 'tasks', 'profile'];
const state = {
  data: null,
  view: 'home',
  busy: false,
  initData: '',
};

const $ = (id) => document.getElementById(id);
const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function fmt(value) {
  const n = Number(value || 0);
  return num.format(Number.isInteger(n) ? n : Math.round(n * 100) / 100);
}

function money(value) {
  return `${fmt(value)} Active`;
}

function shortDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', Boolean(isError));
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function haptic(type = 'light') {
  try {
    if (!tg || !tg.HapticFeedback) return;
    if (type === 'success' || type === 'error') tg.HapticFeedback.notificationOccurred(type);
    else tg.HapticFeedback.impactOccurred(type);
  } catch { /* haptics are optional */ }
}

function readInitData() {
  if (tg && tg.initData) return tg.initData;
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) {
    const params = new URLSearchParams(hash);
    const value = params.get('tgWebAppData');
    if (value) return value;
  }
  return new URLSearchParams(window.location.search).get('initData') || '';
}

function deviceId() {
  const key = 'coinvera_device';
  let id = '';
  try { id = localStorage.getItem(key) || ''; } catch { /* storage blocked */ }
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    const raw = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `dev${Date.now()}${Math.random().toString(16).slice(2)}`;
    id = raw.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
    try { localStorage.setItem(key, id); } catch { /* storage blocked */ }
  }
  return id;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.initData) headers['x-telegram-init-data'] = state.initData;
  else headers['x-coinvera-guest'] = deviceId();
  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { data = { ok: false, error: 'bad_response' }; }
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `http_${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

/* ---------------- rendering ---------------- */

function activityRow(item) {
  const li = document.createElement('li');
  const main = document.createElement('div');
  main.className = 'row-main';
  const title = document.createElement('span');
  title.className = 'row-title';
  title.textContent = item.title;
  const sub = document.createElement('span');
  sub.className = 'row-sub';
  sub.textContent = shortDate(item.createdAt);
  main.append(title, sub);

  const value = document.createElement('span');
  if (!item.amount || item.unit === 'WALLET') {
    value.className = 'row-value';
    value.textContent = '—';
  } else {
    const isPoints = item.unit === 'POINTS';
    value.className = `row-value ${isPoints ? 'pos' : 'neg'}`;
    value.textContent = isPoints ? `+${fmt(item.amount)} pts` : `+${fmt(item.amount)} Active`;
  }
  li.append(main, value);
  return li;
}

function fillList(container, items, emptyText) {
  container.replaceChildren();
  if (!items || !items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    container.append(li);
    return;
  }
  items.forEach((item) => container.append(activityRow(item)));
}

function renderTasks() {
  const list = $('task-list');
  const tasks = state.data.tasks || [];
  list.replaceChildren();

  if (!tasks.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'New tasks are added regularly. Check back soon.';
    list.append(p);
    return;
  }

  tasks.forEach((task) => {
    const card = document.createElement('div');
    card.className = `task${task.completed ? ' done' : ''}`;

    const icon = document.createElement('div');
    icon.className = 'task-icon';
    icon.textContent = task.completed ? '✅' : '🎯';

    const body = document.createElement('div');
    body.className = 'task-body';

    const title = document.createElement('h4');
    title.textContent = task.title;

    const desc = document.createElement('p');
    desc.textContent = task.description;

    const meta = document.createElement('div');
    meta.className = 'task-meta';

    const reward = document.createElement('span');
    reward.className = 'reward';
    reward.textContent = `+${fmt(task.rewardPoints)} Active Points`;
    meta.append(reward);

    if (task.completed) {
      const done = document.createElement('span');
      done.className = 'claimed';
      done.textContent = '✓ Completed';
      meta.append(done);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = task.actionLabel || 'Complete';
      button.addEventListener('click', () => claimTask(task.code, button));
      meta.append(button);
    }

    body.append(title, desc, meta);
    card.append(icon, body);
    list.append(card);
  });
}

function renderReferrals() {
  const { referrals, user } = state.data;
  $('referral-code').textContent = referrals.code || user.referralCode || '—';
  $('referral-count').textContent = fmt(referrals.count);
  $('referral-points').textContent = fmt(referrals.pointsEarned);

  const list = $('referral-list');
  list.replaceChildren();
  if (!referrals.items || !referrals.items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No referrals yet — share your code to start earning.';
    list.append(li);
    return;
  }
  referrals.items.forEach((item) => {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'row-main';
    const title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = item.username ? `@${item.username}` : item.name;
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent = `Joined ${shortDate(item.joinedAt)}`;
    main.append(title, sub);
    const value = document.createElement('span');
    value.className = 'row-value pos';
    value.textContent = `+${fmt(item.rewardPoints)} pts`;
    li.append(main, value);
    list.append(li);
  });
}

function renderAdmin() {
  const admin = state.data.admin;
  if (!admin) return;
  $('admin-id').textContent = `Telegram ID ${state.data.config.adminTelegramId}`;

  const cards = [
    ['Total users', admin.totalUsers, 'emerald'],
    ['New today', admin.registrationsToday, ''],
    ['Tasks completed', admin.tasksCompleted, ''],
    ['Referrals', admin.totalReferrals, ''],
    ['Rewards issued', admin.rewardsIssued, 'gold'],
    ['Points issued', admin.rewardPointsIssued, 'gold'],
    ['Support messages', admin.supportMessages, ''],
    ['Open support', admin.openSupportMessages, ''],
    ['Pending withdrawals', admin.pendingWithdrawals, ''],
    ['Pending amount', `${fmt(admin.pendingWithdrawalAmount)} A`, 'gold'],
    ['Total Active', `${fmt(admin.totalActiveBalance)} A`, 'emerald'],
    ['Total points', fmt(admin.totalPoints), ''],
  ];

  const grid = $('admin-grid');
  grid.replaceChildren();
  cards.forEach(([label, value, tone]) => {
    const card = document.createElement('div');
    card.className = `stat-card ${tone}`.trim();
    const span = document.createElement('span');
    span.textContent = label;
    const b = document.createElement('b');
    b.textContent = typeof value === 'number' ? fmt(value) : String(value);
    card.append(span, b);
    grid.append(card);
  });

  const users = $('admin-users');
  users.replaceChildren();
  (admin.recentUsers || []).forEach((row) => {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'row-main';
    const title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = row.username ? `@${row.username}` : row.name;
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent = `ID ${row.telegramId} · ${row.referralCode} · ${shortDate(row.joinedAt)}`;
    main.append(title, sub);
    const value = document.createElement('span');
    value.className = 'row-value';
    value.textContent = `${fmt(row.activeBalance)} A`;
    li.append(main, value);
    users.append(li);
  });

  const support = $('admin-support');
  support.replaceChildren();
  if (!(admin.supportItems || []).length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No support messages yet.';
    support.append(li);
  } else {
    admin.supportItems.forEach((row) => {
      const li = document.createElement('li');
      const main = document.createElement('div');
      main.className = 'row-main';
      const title = document.createElement('span');
      title.className = 'row-title';
      title.textContent = row.message.length > 60 ? `${row.message.slice(0, 60)}…` : row.message;
      const sub = document.createElement('span');
      sub.className = 'row-sub';
      sub.textContent = `${row.username ? `@${row.username}` : row.name} · ${shortDate(row.createdAt)}`;
      main.append(title, sub);
      const value = document.createElement('span');
      value.className = 'row-value';
      value.textContent = row.status;
      li.append(main, value);
      support.append(li);
    });
  }

  const withdrawals = $('admin-withdrawals');
  withdrawals.replaceChildren();
  if (!(admin.withdrawalItems || []).length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No withdrawal requests.';
    withdrawals.append(li);
  } else {
    admin.withdrawalItems.forEach((row) => {
      const li = document.createElement('li');
      const main = document.createElement('div');
      main.className = 'row-main';
      const title = document.createElement('span');
      title.className = 'row-title';
      title.textContent = `${fmt(row.amount)} Active · ${row.network}`;
      const sub = document.createElement('span');
      sub.className = 'row-sub';
      sub.textContent = `${row.username ? `@${row.username}` : row.telegramId} · ${row.address.slice(0, 10)}…`;
      main.append(title, sub);
      const value = document.createElement('span');
      value.className = 'row-value';
      value.textContent = row.status;
      li.append(main, value);
      withdrawals.append(li);
    });
  }
}

function render() {
  const { user, activity, summary, config } = state.data;

  $('preview-banner').classList.toggle('hidden', !config.preview);

  // home
  $('home-name').textContent = user.displayName || 'COINVERA user';
  $('home-balance').textContent = fmt(user.activeBalance);
  $('home-points').textContent = fmt(user.points);
  $('home-status').textContent = user.status || 'Active';
  fillList($('home-activity'), (activity || []).slice(0, 4), 'No activity yet — complete a task to begin.');
  const openTasks = (state.data.tasks || []).filter((t) => !t.completed).length;
  $('tile-tasks').textContent = openTasks ? `${openTasks} open` : 'All done';
  $('tile-referrals').textContent = `${fmt(state.data.referrals.count)} friend${state.data.referrals.count === 1 ? '' : 's'}`;

  // balance
  $('balance-value').textContent = fmt(user.activeBalance);
  $('balance-active').textContent = fmt(user.activeBalance);
  $('balance-points').textContent = fmt(user.points);
  $('balance-task-points').textContent = fmt(summary.taskPoints);
  $('balance-min').textContent = fmt(config.minWithdrawal);
  fillList($('balance-activity'), (activity || []).slice(0, 5), 'No movements yet.');

  // tasks / referral / activity
  renderTasks();
  renderReferrals();
  fillList($('activity-list'), activity || [], 'Your history will appear here.');

  // profile
  const initial = (user.displayName || 'C').trim().charAt(0).toUpperCase();
  $('profile-avatar').textContent = initial || 'C';
  $('profile-name').textContent = user.displayName || 'COINVERA user';
  $('profile-username').textContent = user.username ? `@${user.username}` : 'No public username';
  $('profile-status').textContent = user.status || 'Active';
  $('profile-tgid').textContent = user.telegramId;
  $('profile-balance').textContent = fmt(user.activeBalance);
  $('profile-points').textContent = fmt(user.points);
  $('profile-code').textContent = user.referralCode;
  $('profile-joined').textContent = shortDate(user.joinedAt);
  $('profile-wallet').textContent = user.walletAddress
    ? `${user.walletAddress.slice(0, 6)}…${user.walletAddress.slice(-4)}`
    : 'Not linked';
  $('profile-admin').classList.toggle('hidden', !user.isAdmin);

  // withdrawal sheet hint
  $('withdraw-hint').textContent = `Minimum ${fmt(config.minWithdrawal)} Active. Available ${fmt(user.activeBalance)} Active.`;
  const amountInput = $('withdraw-amount');
  amountInput.max = String(user.activeBalance);
  if (!$('withdraw-address').value && user.walletAddress) $('withdraw-address').value = user.walletAddress;

  if (user.isAdmin) renderAdmin();
}

/* ---------------- navigation ---------------- */

function showView(name, { push = true } = {}) {
  if (!state.data && name !== 'home') return;
  state.view = name;
  document.querySelectorAll('.view').forEach((section) => {
    section.hidden = section.id !== `view-${name}`;
  });
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === name);
  });
  $('back-btn').classList.toggle('hidden', TABS.includes(name));
  if (name === 'admin' && state.data && state.data.admin) renderAdmin();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  try { tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); } catch { /* optional */ }
  if (push) history.replaceState({ view: name }, '', `#${name}`);
}

/* ---------------- actions ---------------- */

async function claimTask(code, button) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  try {
    const result = await api('/api/tasks/claim', { method: 'POST', body: { code } });
    state.data = result;
    render();
    haptic('success');
    toast(`Task complete — +${fmt(result.awarded)} Active Points`);
  } catch (error) {
    if (error.data && error.data.tasks) {
      state.data = error.data;
      render();
    }
    const map = {
      already_completed: 'This task is already completed.',
      requirement_wallet: 'Wallet linking happens in the bot — open it and tap 🔐 Connect Wallet.'
      requirement_referral: 'Invite at least one friend first.',
      requirement_profile: 'Complete your Telegram profile first.',
      task_not_found: 'That task is no longer available.',
    };
    haptic('error');
    toast(map[error.message] || 'Could not claim this task right now.', true);
    if (error.message === 'requirement_referral') showView('referral');
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}

async function sendSupport(event) {
  event.preventDefault();
  const input = $('support-input');
  const message = input.value.trim();
  if (!message) { toast('Write your message first.', true); return; }
  if (state.busy) return;
  state.busy = true;
  $('support-submit').disabled = true;
  try {
    await api('/api/support', { method: 'POST', body: { message } });
    input.value = '';
    haptic('success');
    toast('Message sent. Support will reply in the bot.');
  } catch {
    toast('Could not send your message.', true);
  } finally {
    state.busy = false;
    $('support-submit').disabled = false;
  }
}

async function submitWithdrawal(event) {
  event.preventDefault();
  if (state.busy) return;
  const amount = Number($('withdraw-amount').value);
  const address = $('withdraw-address').value.trim();
  state.busy = true;
  $('withdraw-submit').disabled = true;
  try {
    const result = await api('/api/withdrawal', { method: 'POST', body: { amount, address } });
    state.data = result;
    closeSheet();
    $('withdraw-form').reset();
    render();
    haptic('success');
    toast('Withdrawal requested. Our team reviews requests before payout.');
  } catch (error) {
    const map = {
      amount_below_minimum: `Minimum withdrawal is ${fmt(state.data.config.minWithdrawal)} Active.`,
      insufficient_balance: 'Amount exceeds your Active balance.',
      amount_invalid: 'Enter a valid amount.',
      wallet_required: 'Add a payout address or link your wallet first.',
      address_invalid: 'That payout address is not valid.',
      looks_like_secret: 'That looks like a private key or recovery phrase — never share those.',
    };
    haptic('error');
    toast(map[error.message] || 'Could not submit that request.', true);
  } finally {
    state.busy = false;
    $('withdraw-submit').disabled = false;
  }
}

function openSheet() {
  $('withdraw-sheet').classList.remove('hidden');
}

function closeSheet() {
  $('withdraw-sheet').classList.add('hidden');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

async function copyCode() {
  const code = state.data.referrals.code;
  const ok = await copyText(code);
  haptic(ok ? 'success' : 'error');
  toast(ok ? `Referral code ${code} copied` : 'Could not copy — long-press to select the code.', !ok);
}

function shareCode() {
  const { code, link } = state.data.referrals;
  const text = `Join me on COINVERA and claim your Active welcome bonus. Use my code ${code}`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
  try {
    if (tg && tg.openTelegramLink) {
      tg.openTelegramLink(shareUrl);
      return;
    }
  } catch { /* fall through */ }
  window.open(shareUrl, '_blank', 'noopener');
}

/* ---------------- boot ---------------- */

function wireEvents() {
  document.querySelectorAll('[data-go]').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.go));
  });
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.tab));
  });
  document.querySelectorAll('[data-close-sheet]').forEach((el) => {
    el.addEventListener('click', closeSheet);
  });
  $('back-btn').addEventListener('click', () => showView('home'));
  $('withdraw-open').addEventListener('click', openSheet);
  $('withdraw-form').addEventListener('submit', submitWithdrawal);
  $('support-form').addEventListener('submit', sendSupport);
  $('copy-code').addEventListener('click', copyCode);
  $('share-code').addEventListener('click', shareCode);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSheet();
  });
}

async function boot() {
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.setHeaderColor && tg.setHeaderColor('#05070a');
      tg.setBackgroundColor && tg.setBackgroundColor('#05070a');
      tg.disableVerticalSwipes && tg.disableVerticalSwipes();
    } catch { /* older Telegram clients */ }
  }

  state.initData = readInitData();
  wireEvents();

  try {
    const data = await api('/api/session');
    state.data = data;
    $('loading').classList.add('hidden');
    $('views').classList.remove('hidden');
    if (data.guest) {
      const banner = $('guest-banner');
      if (banner) banner.classList.remove('hidden');
    }
    render();
    const fromHash = window.location.hash.replace(/^#/, '');
    showView(TABS.concat(['referral', 'activity', 'walletinfo', 'help']).includes(fromHash) ? fromHash : 'home', { push: false });
  } catch (error) {
    if (error.status === 401 && state.initData && !boot.guestRetry) {
      // Telegram sign-in could not be verified (for example the bot domain is
      // not registered in BotFather yet). Fall back to a device-scoped guest
      // session so the app still opens instead of dead-ending on one screen.
      boot.guestRetry = true;
      state.initData = '';
      $('auth-error').classList.add('hidden');
      $('loading').classList.remove('hidden');
      return boot();
    }
    $('loading').classList.add('hidden');
    $('auth-error').classList.remove('hidden');
    const detail = error.data || {};
    const reason = detail.error || error.message || 'unknown';
    if (error.status === 401) {
      $('auth-error-text').textContent =
        detail.message || 'COINVERA verifies every account with Telegram. Open the app from the bot button to continue.';
    } else {
      $('auth-error-text').textContent = 'The service is temporarily unavailable. Please reopen the app in a moment.';
    }
    const reasonEl = $('auth-error-reason');
    if (reasonEl) {
      const fields = detail.diagnostics && detail.diagnostics.fields && detail.diagnostics.fields.length
        ? ` \u00b7 fields: ${detail.diagnostics.fields.join(', ')}`
        : '';
      reasonEl.textContent = `Reason: ${reason}${fields}`;
    }
    const retry = $('auth-retry');
    if (retry) retry.addEventListener('click', () => window.location.reload());
  }
}

boot();
