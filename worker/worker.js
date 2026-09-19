/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  SKFaq · Jurnal Trading Harian — Cloudflare Worker API    ║
 * ║                                                            ║
 * ║  Endpoint:                                                 ║
 * ║    GET    /api/summary?today=YYYY-MM-DD                    ║
 * ║             → settings + statistik lengkap + semua entry   ║
 * ║    GET    /api/entries?from=&to=&limit=                    ║
 * ║    POST   /api/entries   { date, start_balance,            ║
 * ║                            end_balance, note,              ║
 * ║                            allow_weekend }   (upsert)      ║
 * ║    DELETE /api/entries?date=YYYY-MM-DD                     ║
 * ║    GET    /api/settings                                    ║
 * ║    POST   /api/settings  { initial_capital, ... }          ║
 * ║    GET    /  |  /health                                    ║
 * ║                                                            ║
 * ║  Aplikasi pribadi — semua endpoint publik, tanpa auth.     ║
 * ╚═══════════════════════════════════════════════════════════╝
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  // Authorization WAJIB disebut: tanpa ini browser memblokir preflight
  // untuk setiap permintaan yang membawa token sesi.
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });

const fail = (message, status = 400) => json({ ok: false, error: message }, status);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─────────────────────────────────────────────────────────
//  UTIL TANGGAL (semua dihitung di UTC agar deterministik)
// ─────────────────────────────────────────────────────────
const toUTC = (d) => new Date(`${d}T00:00:00Z`);

function isValidDate(d) {
  if (!DATE_RE.test(d)) return false;
  const dt = toUTC(d);
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

/** 0 = Minggu … 6 = Sabtu */
const dayOfWeek = (d) => toUTC(d).getUTCDay();
const isWeekend = (d) => dayOfWeek(d) === 0 || dayOfWeek(d) === 6;

/** Senin pada minggu yang sama dengan `d` (ISO week, Senin = awal) */
function mondayOf(d) {
  const dt = toUTC(d);
  const shift = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - shift);
  return dt.toISOString().slice(0, 10);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ═════════════════════════════════════════════════════════
//  AUTENTIKASI
// ═════════════════════════════════════════════════════════
const SESSION_DAYS = 30;
const PBKDF2_ITER = 100000;   // batas maksimum Web Crypto di Cloudflare Workers

const toHex = (buf) =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return toHex(arr);
}

async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations },
    key, 256
  );
  return toHex(bits);
}

/** Perbandingan waktu tetap agar tidak bocor lewat timing */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const normalizeUsername = (u) => String(u ?? "").trim().toLowerCase();

function validCredentials(username, password) {
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return "Username 3–32 karakter, hanya huruf, angka, titik, garis bawah, atau strip";
  }
  if (typeof password !== "string" || password.length < 8) {
    return "Password minimal 8 karakter";
  }
  if (password.length > 200) return "Password terlalu panjang";
  return null;
}

async function createSession(env, userId) {
  const token = randomHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)"
  ).bind(token, userId, expires).run();
  return { token, expires_at: expires };
}

/** Mengembalikan { id, username, role } bila token sah, atau null */
async function authUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token.length < 16) return null;

  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.username, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  ).bind(token).first();

  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return { id: row.user_id, username: row.username, role: row.role, token };
}

async function userCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  return row?.n ?? 0;
}

async function handleRegister(request, env) {
  let b;
  try { b = await request.json(); } catch { return fail("JSON tidak valid"); }

  const username = normalizeUsername(b.username);
  const password = b.password;
  const problem = validCredentials(username, password);
  if (problem) return fail(problem);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?")
    .bind(username).first();
  if (existing) return fail("Username sudah dipakai", 409);

  // Pendaftar pertama menjadi admin dan mewarisi seluruh data lama (user_id = 1)
  const isFirst = (await userCount(env)) === 0;
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt, PBKDF2_ITER);

  const res = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, salt, iterations, role)
     VALUES (?,?,?,?,?)`
  ).bind(username, hash, salt, PBKDF2_ITER, isFirst ? "admin" : "user").run();

  const userId = res.meta?.last_row_id;
  const session = await createSession(env, userId);

  return json({
    ok: true,
    token: session.token,
    expires_at: session.expires_at,
    user: { id: userId, username, role: isFirst ? "admin" : "user" },
    inherited_data: isFirst,
  });
}

async function handleLogin(request, env) {
  let b;
  try { b = await request.json(); } catch { return fail("JSON tidak valid"); }

  const username = normalizeUsername(b.username);
  const password = String(b.password ?? "");
  if (!username || !password) return fail("Username dan password wajib diisi");

  const user = await env.DB.prepare(
    "SELECT id, username, password_hash, salt, iterations, role FROM users WHERE username = ?"
  ).bind(username).first();

  // Tetap hitung hash walau user tidak ada, agar waktu responsnya seragam
  const salt = user ? user.salt : "00000000000000000000000000000000";
  const iter = user ? user.iterations : PBKDF2_ITER;
  const hash = await hashPassword(password, salt, iter);

  if (!user || !safeEqual(hash, user.password_hash)) {
    return fail("Username atau password salah", 401);
  }

  const session = await createSession(env, user.id);
  return json({
    ok: true,
    token: session.token,
    expires_at: session.expires_at,
    user: { id: user.id, username: user.username, role: user.role },
  });
}

async function handleLogout(request, env, user) {
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(user.token).run();
  return json({ ok: true });
}

async function handlePasswordChange(request, env, user) {
  let b;
  try { b = await request.json(); } catch { return fail("JSON tidak valid"); }

  const current = String(b.current_password ?? "");
  const next = String(b.new_password ?? "");
  if (next.length < 8) return fail("Password baru minimal 8 karakter");

  const row = await env.DB.prepare(
    "SELECT password_hash, salt, iterations FROM users WHERE id = ?"
  ).bind(user.id).first();
  if (!row) return fail("Akun tidak ditemukan", 404);

  const check = await hashPassword(current, row.salt, row.iterations);
  if (!safeEqual(check, row.password_hash)) return fail("Password lama salah", 401);

  const salt = randomHex(16);
  const hash = await hashPassword(next, salt, PBKDF2_ITER);
  await env.DB.prepare(
    "UPDATE users SET password_hash=?, salt=?, iterations=? WHERE id=?"
  ).bind(hash, salt, PBKDF2_ITER, user.id).run();

  // Semua sesi lain dicabut, sesi sekarang dipertahankan
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?")
    .bind(user.id, user.token).run();

  return json({ ok: true });
}

// ─────────────────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────────────────
const SETTING_KEYS = [
  "initial_capital", "monthly_target", "currency", "finance_currency",
  "carry_over", "carry_start_month", "carry_opening", "auto_pay_past", "usd_rate",
];
const STRING_SETTINGS = ["currency", "finance_currency", "carry_start_month"];

async function readSettings(env, userId) {
  const res = await env.DB.prepare(
    "SELECT key, value FROM user_settings WHERE user_id = ?"
  ).bind(userId).all();
  const out = {
    initial_capital: 0, monthly_target: 0, currency: "IDR", finance_currency: "IDR",
    carry_over: 1,            // 1 = sisa bulan ini dibawa ke bulan berikutnya
    carry_start_month: "",    // "" = otomatis dari bulan data paling awal
    carry_opening: 0,         // saldo pembuka pada carry_start_month
    auto_pay_past: 1,         // anggap cicilan bulan-bulan lalu sudah dibayar
    usd_rate: 16000,          // kurs bila mata uang jurnal ≠ mata uang keuangan
  };
  for (const row of res.results ?? []) {
    if (STRING_SETTINGS.includes(row.key)) out[row.key] = row.value;
    else out[row.key] = Number(row.value) || 0;
  }
  return out;
}

async function handleSettingsPost(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("JSON tidak valid");
  }

  const writes = [];
  for (const key of SETTING_KEYS) {
    if (body[key] === undefined || body[key] === null) continue;
    let value = body[key];
    if (key === "carry_start_month") {
      value = String(value).trim().slice(0, 7);
      if (value && !isValidMonth(value)) return fail("Bulan mulai carry harus YYYY-MM");
    } else if (STRING_SETTINGS.includes(key)) {
      value = String(value).slice(0, 8).toUpperCase();
    } else {
      const num = Number(value);
      if (!isFinite(num) || num < 0) return fail(`Nilai ${key} tidak valid`);
      value = String(num);
    }
    writes.push(
      env.DB.prepare(
        `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value,
                                                 updated_at = CURRENT_TIMESTAMP`
      ).bind(user.id, key, value)
    );
  }

  if (writes.length) await env.DB.batch(writes);
  return json({ ok: true, settings: await readSettings(env, user.id) });
}

// ─────────────────────────────────────────────────────────
//  ENTRIES
// ─────────────────────────────────────────────────────────
async function allEntries(env, userId) {
  const res = await env.DB.prepare(
    `SELECT date, start_balance, end_balance, note, updated_at
       FROM daily_entries
      WHERE user_id = ?
      ORDER BY date ASC`
  ).bind(userId).all();

  return (res.results ?? []).map((e) => {
    const pnl = round2(e.end_balance - e.start_balance);
    return {
      date: e.date,
      start_balance: round2(e.start_balance),
      end_balance: round2(e.end_balance),
      pnl,
      pnl_pct: e.start_balance > 0 ? round2((pnl / e.start_balance) * 100) : 0,
      note: e.note ?? null,
      weekend: isWeekend(e.date),
      updated_at: e.updated_at ?? null,
    };
  });
}

async function handleEntriesGet(request, env, user) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = Math.min(parseInt(url.searchParams.get("limit")) || 500, 2000);

  let entries = await allEntries(env, user.id);
  if (from && isValidDate(from)) entries = entries.filter((e) => e.date >= from);
  if (to && isValidDate(to)) entries = entries.filter((e) => e.date <= to);
  if (entries.length > limit) entries = entries.slice(-limit);

  return json({ ok: true, entries, count: entries.length });
}

async function handleEntryPost(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("JSON tidak valid");
  }

  const date = String(body.date ?? "").slice(0, 10);
  if (!isValidDate(date)) return fail("Format tanggal harus YYYY-MM-DD");

  const start = Number(body.start_balance);
  const end = Number(body.end_balance);
  if (!isFinite(start) || start < 0) return fail("Saldo awal tidak valid");
  if (!isFinite(end) || end < 0) return fail("Saldo akhir tidak valid");
  if (start > 1e12 || end > 1e12) return fail("Nilai saldo di luar batas wajar");

  if (isWeekend(date) && !body.allow_weekend) {
    return fail(
      "Sabtu & Minggu adalah hari libur market. Centang “tetap simpan” bila memang perlu.",
      422
    );
  }

  const note = body.note ? String(body.note).slice(0, 280) : null;

  await env.DB.prepare(
    `INSERT INTO daily_entries (user_id, date, start_balance, end_balance, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       start_balance = excluded.start_balance,
       end_balance   = excluded.end_balance,
       note          = excluded.note,
       updated_at    = CURRENT_TIMESTAMP`
  )
    .bind(user.id, date, round2(start), round2(end), note)
    .run();

  return json({
    ok: true,
    entry: {
      date,
      start_balance: round2(start),
      end_balance: round2(end),
      pnl: round2(end - start),
      note,
      weekend: isWeekend(date),
    },
  });
}

async function handleEntryDelete(request, env, user) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  if (!isValidDate(date)) return fail("Format tanggal harus YYYY-MM-DD");

  const res = await env.DB.prepare(
    "DELETE FROM daily_entries WHERE user_id = ? AND date = ?"
  ).bind(user.id, date).run();

  const removed = res.meta?.changes ?? 0;
  if (!removed) return fail("Entry tidak ditemukan", 404);
  return json({ ok: true, deleted: date });
}

// ─────────────────────────────────────────────────────────
//  STATISTIK
// ─────────────────────────────────────────────────────────
function computeStats(entries, settings, today, withdrawals) {
  const base = {
    has_data: false,
    initial_capital: settings.initial_capital || 0,
    current_balance: settings.initial_capital || 0,
    total_pnl: 0,
    total_pnl_pct: 0,
    net_adjustment: 0,
    trading_days: 0,
    win_days: 0,
    loss_days: 0,
    flat_days: 0,
    win_rate: 0,
    gross_profit: 0,
    gross_loss: 0,
    profit_factor: 0,
    avg_pnl: 0,
    avg_win: 0,
    avg_loss: 0,
    best_day: null,
    worst_day: null,
    max_drawdown_pct: 0,
    max_drawdown_amount: 0,
    peak_balance: settings.initial_capital || 0,
    current_streak: 0,
    streak_type: "none",
    longest_win_streak: 0,
    longest_loss_streak: 0,
    today: null,
    week_pnl: 0,
    week_days: 0,
    month_pnl: 0,
    month_days: 0,
    month_win_days: 0,
    month_target_pct: 0,
    first_date: null,
    last_date: null,
    withdrawn_total_usd: 0,
    withdrawn_month_usd: 0,
    withdrawn_after_last_entry: 0,
    balance_after_withdrawal: settings.initial_capital || 0,
    equity_effective: settings.initial_capital || 0,
    withdrawal_count: 0,
  };

  const wds = withdrawals || [];
  const wdTotal = round2(wds.reduce((a, w) => a + w.amount_usd, 0));
  const wdMonth = round2(
    wds.filter((w) => w.date.slice(0, 7) === today.slice(0, 7)).reduce((a, w) => a + w.amount_usd, 0)
  );

  if (!entries.length) {
    base.withdrawn_total_usd = wdTotal;
    base.withdrawn_month_usd = wdMonth;
    base.withdrawal_count = wds.length;
    return base;
  }

  const n = entries.length;
  const first = entries[0];
  const last = entries[n - 1];

  const initial =
    settings.initial_capital > 0 ? settings.initial_capital : first.start_balance;

  let totalPnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let win = 0;
  let loss = 0;
  let flat = 0;
  let netAdjustment = 0;
  let peak = entries[0].start_balance;   // dibandingkan terhadap ekuitas efektif
  let maxDdPct = 0;
  let maxDdAmount = 0;
  let best = entries[0];
  let worst = entries[0];
  let longestWin = 0;
  let longestLoss = 0;
  let runWin = 0;
  let runLoss = 0;

  entries.forEach((e, i) => {
    const pnl = e.pnl;
    totalPnl += pnl;

    if (pnl > 0) {
      grossProfit += pnl;
      win++;
      runWin++;
      runLoss = 0;
    } else if (pnl < 0) {
      grossLoss += Math.abs(pnl);
      loss++;
      runLoss++;
      runWin = 0;
    } else {
      flat++;
      runWin = 0;
      runLoss = 0;
    }
    longestWin = Math.max(longestWin, runWin);
    longestLoss = Math.max(longestLoss, runLoss);

    if (i > 0) netAdjustment += e.start_balance - entries[i - 1].end_balance;
    if (pnl > best.pnl) best = e;
    if (pnl < worst.pnl) worst = e;

    const equity = e.equity_adj !== undefined ? e.equity_adj : e.end_balance;
    peak = Math.max(peak, equity);
    const ddAmount = peak - equity;
    if (ddAmount > maxDdAmount) maxDdAmount = ddAmount;
    const ddPct = peak > 0 ? (ddAmount / peak) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  });

  // Streak berjalan (dihitung mundur dari entry terakhir)
  let streak = 0;
  let streakType = "none";
  for (let i = n - 1; i >= 0; i--) {
    const pnl = entries[i].pnl;
    if (pnl === 0) break;
    const type = pnl > 0 ? "win" : "loss";
    if (streakType === "none") streakType = type;
    if (type !== streakType) break;
    streak++;
  }

  const todayEntry = today ? entries.find((e) => e.date === today) ?? null : null;

  const monthKey = (today ?? last.date).slice(0, 7);
  const monthEntries = entries.filter((e) => e.date.slice(0, 7) === monthKey);
  const monthPnl = monthEntries.reduce((a, e) => a + e.pnl, 0);

  const weekStart = mondayOf(today ?? last.date);
  const weekEntries = entries.filter((e) => e.date >= weekStart);
  const weekPnl = weekEntries.reduce((a, e) => a + e.pnl, 0);

  const decided = win + loss;

  return {
    has_data: true,
    initial_capital: round2(initial),
    current_balance: round2(last.end_balance),
    total_pnl: round2(totalPnl),
    total_pnl_pct: initial > 0 ? round2((totalPnl / initial) * 100) : 0,
    net_adjustment: round2(netAdjustment),
    trading_days: n,
    win_days: win,
    loss_days: loss,
    flat_days: flat,
    win_rate: decided > 0 ? round2((win / decided) * 100) : 0,
    gross_profit: round2(grossProfit),
    gross_loss: round2(grossLoss),
    profit_factor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? 99.99 : 0,
    avg_pnl: round2(totalPnl / n),
    avg_win: win > 0 ? round2(grossProfit / win) : 0,
    avg_loss: loss > 0 ? round2(grossLoss / loss) : 0,
    best_day: { date: best.date, pnl: best.pnl, pnl_pct: best.pnl_pct },
    worst_day: { date: worst.date, pnl: worst.pnl, pnl_pct: worst.pnl_pct },
    max_drawdown_pct: round2(maxDdPct),
    max_drawdown_amount: round2(maxDdAmount),
    peak_balance: round2(peak),
    current_streak: streak,
    streak_type: streak > 0 ? streakType : "none",
    longest_win_streak: longestWin,
    longest_loss_streak: longestLoss,
    today: todayEntry
      ? { date: todayEntry.date, pnl: todayEntry.pnl, pnl_pct: todayEntry.pnl_pct }
      : null,
    week_pnl: round2(weekPnl),
    week_days: weekEntries.length,
    month_pnl: round2(monthPnl),
    month_days: monthEntries.length,
    month_win_days: monthEntries.filter((e) => e.pnl > 0).length,
    month_target_pct:
      settings.monthly_target > 0
        ? round2((monthPnl / settings.monthly_target) * 100)
        : 0,
    first_date: first.date,
    last_date: last.date,
    withdrawn_total_usd: wdTotal,
    withdrawn_month_usd: wdMonth,
    // Ekuitas efektif: saldo tercatat + seluruh dana yang sudah ditarik.
    // Penarikan hanya mengurangi saldo, bukan hasil kerja — jadi progres target
    // dan drawdown tetap dihitung dari angka ini.
    equity_effective: round2(
      last.end_balance + wds.filter((w) => w.date <= last.date).reduce((a, w) => a + w.amount_usd, 0)
    ),
    // Penarikan setelah entry terakhir belum tercermin di saldo yang tercatat
    withdrawn_after_last_entry: round2(
      wds.filter((w) => w.date > last.date).reduce((a, w) => a + w.amount_usd, 0)
    ),
    balance_after_withdrawal: round2(
      last.end_balance - wds.filter((w) => w.date > last.date).reduce((a, w) => a + w.amount_usd, 0)
    ),
    withdrawal_count: wds.length,
  };
}

async function handleSummary(request, env, user) {
  const url = new URL(request.url);
  let today = url.searchParams.get("today") ?? "";
  if (!isValidDate(today)) today = new Date().toISOString().slice(0, 10);

  const [settings, entries, wdRes] = await Promise.all([
    readSettings(env, user.id),
    allEntries(env, user.id),
    env.DB.prepare(
      `SELECT id, date, amount_usd, rate, amount, note FROM withdrawals
        WHERE user_id = ? ORDER BY date DESC, id DESC`
    ).bind(user.id).all(),
  ]);

  const withdrawals = (wdRes.results ?? []).map((w) => ({
    id: w.id,
    date: w.date,
    amount_usd: round2(w.amount_usd),
    rate: round2(w.rate),
    amount: round2(w.amount),
    note: w.note ?? null,
  }));

  // Tambahkan ekuitas efektif tiap hari: saldo hari itu + penarikan s.d. tanggal tsb
  const sortedW = withdrawals.slice().sort((a, b) => a.date.localeCompare(b.date));
  let wIdx = 0;
  let wCum = 0;
  for (const e of entries) {
    while (wIdx < sortedW.length && sortedW[wIdx].date <= e.date) {
      wCum = round2(wCum + sortedW[wIdx].amount_usd);
      wIdx++;
    }
    e.withdrawn_to_date = wCum;
    e.equity_adj = round2(e.end_balance + wCum);
  }

  const stats = computeStats(entries, settings, today, withdrawals);

  return json({
    ok: true,
    today,
    settings,
    user: { id: user.id, username: user.username, role: user.role },
    stats,
    entries,
    withdrawals,
    server_time: new Date().toISOString(),
  });
}

// ═════════════════════════════════════════════════════════
//  MODUL KEUANGAN — pemasukan, hutang, pengeluaran
// ═════════════════════════════════════════════════════════
const MONTH_RE = /^\d{4}-\d{2}$/;
const isValidMonth = (m) => MONTH_RE.test(m) && Number(m.slice(5, 7)) >= 1 && Number(m.slice(5, 7)) <= 12;

const INCOME_CATS = ["gaji", "bonus", "freelance", "trading", "lainnya"];
const EXPENSE_CATS = ["tagihan", "transport", "makan", "keluarga", "cicilan", "lainnya"];

function daysInMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthShift(month, delta) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** Tanggal jatuh tempo pada bulan tertentu, di-clamp ke jumlah hari bulan itu */
function dueDateIn(month, day) {
  const dim = daysInMonth(month);
  const d = Math.min(Math.max(Number(day) || 1, 1), dim);
  return month + "-" + String(d).padStart(2, "0");
}

const daysBetween = (from, to) =>
  Math.round((toUTC(to).getTime() - toUTC(from).getTime()) / 86400000);

const monthsBetween = (from, to) => {
  const [ya, ma] = from.split("-").map(Number);
  const [yb, mb] = to.split("-").map(Number);
  return (yb - ya) * 12 + (mb - ma);
};

const expenseAppliesTo = (e, month) =>
  e.type === "rutin"
    ? (!e.start_month || e.start_month <= month) && (!e.end_month || e.end_month >= month)
    : e.month === month;

async function loadFinanceRaw(env, userId) {
  const [inc, debts, pays, exp, trading, wd] = await Promise.all([
    env.DB.prepare("SELECT * FROM incomes WHERE user_id = ? ORDER BY month DESC, id DESC").bind(userId).all(),
    env.DB.prepare("SELECT * FROM debts WHERE user_id = ? ORDER BY id ASC").bind(userId).all(),
    env.DB.prepare("SELECT * FROM debt_payments WHERE user_id = ?").bind(userId).all(),
    env.DB.prepare("SELECT * FROM expenses WHERE user_id = ? ORDER BY id ASC").bind(userId).all(),
    env.DB.prepare(
      `SELECT substr(date,1,7) AS month,
              COALESCE(SUM(end_balance - start_balance),0) AS pnl,
              COUNT(*) AS days
         FROM daily_entries WHERE user_id = ? GROUP BY substr(date,1,7)`
    ).bind(userId).all(),
    env.DB.prepare("SELECT * FROM withdrawals WHERE user_id = ? ORDER BY date DESC, id DESC").bind(userId).all(),
  ]);

  return {
    incomes: inc.results ?? [],
    debts: debts.results ?? [],
    payments: pays.results ?? [],
    expenses: exp.results ?? [],
    trading: trading.results ?? [],
    withdrawals: (wd.results ?? []).map((w) => ({
      id: w.id,
      date: w.date,
      month: w.date.slice(0, 7),
      amount_usd: round2(w.amount_usd),
      rate: round2(w.rate),
      amount: round2(w.amount),
      note: w.note ?? null,
    })),
  };
}

/**
 * Menandai cicilan bulan-bulan yang sudah lewat sebagai terbayar.
 * Hanya untuk bulan < bulan berjalan, hanya bila hutang punya start_month,
 * dan tidak pernah menimpa baris yang sudah ada (termasuk yang sengaja
 * ditandai "belum bayar" oleh user, yaitu baris beramount 0).
 */
async function autoPayPastDebts(env, today, userId) {
  const currentMonth = today.slice(0, 7);

  const [debtsRes, paysRes] = await Promise.all([
    env.DB.prepare("SELECT * FROM debts WHERE user_id = ?").bind(userId).all(),
    env.DB.prepare("SELECT debt_id, month, amount FROM debt_payments WHERE user_id = ?").bind(userId).all(),
  ]);

  const debts = debtsRes.results ?? [];
  if (!debts.length) return 0;

  const rows = paysRes.results ?? [];
  const existing = new Set(rows.map((p) => p.debt_id + "|" + p.month));
  const paidTotal = new Map();
  for (const p of rows) paidTotal.set(p.debt_id, (paidTotal.get(p.debt_id) || 0) + p.amount);

  const inserts = [];
  const closes = [];

  for (const d of debts) {
    if (!isValidMonth(d.start_month)) continue;      // tanpa bulan mulai tidak bisa diasumsikan
    if (d.start_month >= currentMonth) continue;
    if (d.monthly_installment <= 0) continue;

    let remaining = round2(d.total_amount - (paidTotal.get(d.id) || 0));
    if (remaining <= 0.009) continue;

    let m = d.start_month;
    let guard = 0;
    while (m < currentMonth && remaining > 0.009 && guard++ < 240) {
      if (d.final_due_date && d.final_due_date.slice(0, 7) < m) break;
      if (!existing.has(d.id + "|" + m)) {
        const amount = round2(Math.min(d.monthly_installment, remaining));
        inserts.push(
          env.DB.prepare(
            "INSERT INTO debt_payments (user_id, debt_id, month, amount, auto) VALUES (?,?,?,?,1)"
          ).bind(userId, d.id, m, amount)
        );
        remaining = round2(remaining - amount);
      }
      m = monthShift(m, 1);
    }

    if (remaining <= 0.009 && d.status !== "lunas") {
      closes.push(
        env.DB.prepare(
          "UPDATE debts SET status='lunas', updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?"
        ).bind(d.id, userId)
      );
    }
  }

  if (inserts.length || closes.length) await env.DB.batch([...inserts, ...closes]);
  return inserts.length;
}

/** Sinkronkan kolom status dengan akumulasi pembayaran sesungguhnya */
async function syncDebtStatus(env, debtId, userId) {
  const row = await env.DB.prepare(
    `SELECT d.total_amount AS total,
            COALESCE((SELECT SUM(amount) FROM debt_payments WHERE debt_id = d.id), 0) AS paid,
            d.status AS status
       FROM debts d WHERE d.id = ? AND d.user_id = ?`
  ).bind(debtId, userId).first();
  if (!row) return;

  const next = row.paid >= row.total - 0.009 ? "lunas" : "aktif";
  if (next !== row.status) {
    await env.DB.prepare(
      "UPDATE debts SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?"
    ).bind(next, debtId, userId).run();
  }
}

function buildFinance(raw, month, today, settings) {
  const paidByDebt = new Map();
  const paidByKey = new Map();
  for (const p of raw.payments) {
    if (p.amount > 0) paidByDebt.set(p.debt_id, (paidByDebt.get(p.debt_id) || 0) + p.amount);
    paidByKey.set(p.debt_id + "|" + p.month, p);
  }

  // ── Hutang diperkaya ──
  const debts = raw.debts.map((d) => {
    const paid = round2(paidByDebt.get(d.id) || 0);
    const remaining = Math.max(round2(d.total_amount - paid), 0);
    const lunas = d.status === "lunas" || remaining <= 0.009;
    const dueThis = dueDateIn(month, d.due_day);
    const payRow = paidByKey.get(d.id + "|" + month) || null;
    const paidThisMonth = !!payRow && payRow.amount > 0;
    const skippedThisMonth = !!payRow && payRow.amount <= 0;
    const activeThisMonth =
      !lunas && (!d.start_month || d.start_month <= month) &&
      (!d.final_due_date || d.final_due_date.slice(0, 7) >= month);

    return {
      id: d.id,
      label: d.label,
      total_amount: round2(d.total_amount),
      monthly_installment: round2(d.monthly_installment),
      due_day: d.due_day ?? null,
      final_due_date: d.final_due_date ?? null,
      start_month: d.start_month ?? null,
      note: d.note ?? null,
      status: lunas ? "lunas" : "aktif",
      status_stored: d.status,
      paid_amount: paid,
      remaining,
      progress_pct: d.total_amount > 0 ? round2((paid / d.total_amount) * 100) : 0,
      months_left:
        d.monthly_installment > 0 ? Math.ceil(remaining / d.monthly_installment) : null,
      installments_paid: raw.payments.filter((p) => p.debt_id === d.id && p.amount > 0).length,
      due_date_this_month: dueThis,
      days_to_due: daysBetween(today, dueThis),
      paid_this_month: paidThisMonth,
      paid_auto_this_month: paidThisMonth && Number(payRow.auto) === 1,
      skipped_this_month: skippedThisMonth,
      auto_paid_count: raw.payments.filter((p) => p.debt_id === d.id && Number(p.auto) === 1).length,
      due_this_month: 0,      // diisi setelah dueFor tersedia
      active_this_month: activeThisMonth,
    };
  });

  // ── Akumulasi pembayaran nyata SEBELUM bulan tertentu ──
  const paymentsByDebt = new Map();
  for (const p of raw.payments) {
    if (p.amount <= 0) continue;
    if (!paymentsByDebt.has(p.debt_id)) paymentsByDebt.set(p.debt_id, []);
    paymentsByDebt.get(p.debt_id).push(p);
  }
  const paidBefore = (debtId, m) =>
    (paymentsByDebt.get(debtId) || []).reduce((a, p) => (p.month < m ? a + p.amount : a), 0);

  const currentMonth = today.slice(0, 7);

  /**
   * Cicilan yang jatuh pada bulan `m` untuk satu hutang.
   * Berhenti sendiri ketika tenor habis atau total hutang sudah tertutup,
   * dan bulan-bulan lampau tetap memakai kondisi saat itu — bukan status hari ini.
   */
  function dueFor(d, m) {
    if (d.monthly_installment <= 0 || d.total_amount <= 0) return 0;
    if (d.start_month && d.start_month > m) return 0;
    if (d.final_due_date && d.final_due_date.slice(0, 7) < m) return 0;
    // Hutang yang ditandai lunas manual: berhenti sejak bulan berjalan
    if (d.status_stored === "lunas" && m >= currentMonth) return 0;

    const scheduled = d.start_month ? monthsBetween(d.start_month, m) * d.monthly_installment : 0;
    const covered = Math.max(scheduled, paidBefore(d.id, m));
    const left = round2(d.total_amount - covered);
    if (left <= 0.009) return 0;
    return round2(Math.min(d.monthly_installment, left));
  }

  // ── Agregat satu bulan ──
  function agg(m) {
    const incomeManual = raw.incomes
      .filter((i) => i.month === m)
      .reduce((a, i) => a + i.amount, 0);
    // Penarikan trading TIDAK dihitung otomatis — dicatat manual sebagai pemasukan
    const income = incomeManual;

    const installment = debts.reduce((a, d) => a + dueFor(d, m), 0);

    const applicable = raw.expenses.filter((e) => expenseAppliesTo(e, m));
    const rutin = applicable.filter((e) => e.type === "rutin").reduce((a, e) => a + e.amount, 0);
    const sekali = applicable.filter((e) => e.type !== "rutin").reduce((a, e) => a + e.amount, 0);
    const outflow = installment + rutin + sekali;

    return {
      month: m,
      income: round2(income),
      income_manual: round2(incomeManual),
      installment: round2(installment),
      expense_rutin: round2(rutin),
      expense_sekali: round2(sekali),
      expense_total: round2(rutin + sekali),
      outflow: round2(outflow),
      buffer: round2(income - outflow),
    };
  }

  // ── Rantai carry-over: sisa bulan sebelumnya menjadi saldo awal bulan ini ──
  const carryOn = Number(settings.carry_over) !== 0;

  const candidates = [];
  for (const i of raw.incomes) candidates.push(i.month);
  for (const e of raw.expenses) {
    if (e.month) candidates.push(e.month);
    if (e.start_month) candidates.push(e.start_month);
  }
  for (const d of raw.debts) if (d.start_month) candidates.push(d.start_month);
  for (const w of raw.withdrawals) candidates.push(w.month);
  candidates.sort();

  let carryStart = isValidMonth(settings.carry_start_month)
    ? settings.carry_start_month
    : candidates[0] || month;
  if (carryStart > month) carryStart = month;
  // Batasi panjang rantai agar tidak pernah meledak
  const floorMonth = monthShift(month, -239);
  if (carryStart < floorMonth) carryStart = floorMonth;

  const trendStart = monthShift(month, -5);
  const chainStart = carryStart < trendStart ? carryStart : trendStart;

  const chain = [];
  let carry = 0;
  let started = false;
  for (let m = chainStart; m <= month; m = monthShift(m, 1)) {
    const a = agg(m);
    if (!started && m >= carryStart) {
      started = true;
      carry = round2(Number(settings.carry_opening) || 0);
    }
    const carryIn = carryOn && started ? round2(carry) : 0;
    a.carry_in = carryIn;
    a.available = round2(carryIn + a.income);
    a.net = round2(carryIn + a.buffer);
    chain.push(a);
    if (carryOn && started) carry = a.net;
  }

  // Lengkapi tagihan bulan yang sedang dilihat, kini berbasis jadwal
  for (const d of debts) {
    d.due_this_month = dueFor(d, month);
    d.active_this_month = d.due_this_month > 0 || d.paid_this_month;
  }

  const cur = chain[chain.length - 1];
  const incomes = raw.incomes.filter((i) => i.month === month);
  const expenses = raw.expenses
    .filter((e) => expenseAppliesTo(e, month))
    .map((e) => ({
      id: e.id,
      label: e.label,
      amount: round2(e.amount),
      category: e.category || "lainnya",
      type: e.type || "rutin",
      month: e.month ?? null,
      start_month: e.start_month ?? null,
      end_month: e.end_month ?? null,
      due_day: e.due_day ?? null,
      note: e.note ?? null,
    }));

  // ── Pengeluaran per kategori (cicilan ikut sebagai satu kategori) ──
  const byCat = new Map();
  for (const e of expenses) byCat.set(e.category, round2((byCat.get(e.category) || 0) + e.amount));
  const expense_by_category = Array.from(byCat, ([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);

  // ── Sisa hari pada bulan berjalan ──
  const dim = daysInMonth(month);
  const isCurrentMonth = today.slice(0, 7) === month;
  const daysLeft = isCurrentMonth
    ? Math.max(dim - Number(today.slice(8, 10)) + 1, 1)
    : dim;

  const tradingRow = raw.trading.find((t) => t.month === month);
  const activeDebts = debts.filter((d) => d.status === "aktif");
  const upcoming = activeDebts
    .filter((d) => d.active_this_month && !d.paid_this_month)
    .sort((a, b) => a.due_date_this_month.localeCompare(b.due_date_this_month));

  const trend = chain.slice(-6);

  return {
    month,
    today,
    summary: {
      income_total: cur.income,
      income_manual: cur.income_manual,
      installment_total: cur.installment,
      installment_paid: round2(
        raw.payments
          .filter((p) => p.month === month && p.amount > 0)
          .reduce((a, p) => a + p.amount, 0)
      ),
      installment_unpaid: round2(
        debts
          .filter((d) => d.active_this_month && !d.paid_this_month)
          .reduce((a, d) => a + d.due_this_month, 0)
      ),
      expense_rutin: cur.expense_rutin,
      expense_sekali: cur.expense_sekali,
      expense_total: cur.expense_total,
      outflow_total: cur.outflow,
      buffer: cur.buffer,
      buffer_pct: cur.income > 0 ? round2((cur.buffer / cur.income) * 100) : 0,
      carry_in: cur.carry_in,
      carry_enabled: carryOn,
      carry_start_month: carryStart,
      available: cur.available,
      net: cur.net,
      net_pct: cur.available > 0 ? round2((cur.net / cur.available) * 100) : 0,
      daily_allowance: round2(Math.max(cur.net, 0) / daysLeft),
      days_left: daysLeft,
      days_in_month: dim,
      is_current_month: isCurrentMonth,
      expense_by_category,
      trading_pnl: round2(tradingRow ? tradingRow.pnl : 0),
      trading_days: tradingRow ? tradingRow.days : 0,
      // Hanya informasi: dipakai sebagai saran pencatatan manual di daftar pemasukan
      withdraw_source: round2(
        raw.withdrawals.filter((w) => w.month === month).reduce((a, w) => a + w.amount_usd, 0)
      ),
      withdraw_amount: round2(
        raw.withdrawals.filter((w) => w.month === month).reduce((a, w) => a + w.amount, 0)
      ),
      withdraw_count: raw.withdrawals.filter((w) => w.month === month).length,
    },
    debt_overview: {
      total_amount: round2(activeDebts.reduce((a, d) => a + d.total_amount, 0)),
      total_paid: round2(debts.reduce((a, d) => a + d.paid_amount, 0)),
      total_remaining: round2(activeDebts.reduce((a, d) => a + d.remaining, 0)),
      active_count: activeDebts.length,
      lunas_count: debts.length - activeDebts.length,
      next_due: upcoming.length
        ? {
            id: upcoming[0].id,
            label: upcoming[0].label,
            date: upcoming[0].due_date_this_month,
            amount: upcoming[0].due_this_month,
            days: upcoming[0].days_to_due,
          }
        : null,
    },
    incomes: incomes.map((i) => ({
      id: i.id,
      month: i.month,
      label: i.label,
      amount: round2(i.amount),
      category: i.category || "lainnya",
      note: i.note ?? null,
    })),
    debts,
    expenses,
    withdrawals: raw.withdrawals.filter((w) => w.month === month),
    trend,
  };
}

async function handleFinance(request, env, user) {
  const url = new URL(request.url);
  let month = url.searchParams.get("month") ?? "";
  let today = url.searchParams.get("today") ?? "";
  if (!isValidDate(today)) today = new Date().toISOString().slice(0, 10);
  if (!isValidMonth(month)) month = today.slice(0, 7);

  const settings = await readSettings(env, user.id);
  if (Number(settings.auto_pay_past) !== 0) await autoPayPastDebts(env, today, user.id);

  const raw = await loadFinanceRaw(env, user.id);
  return json({ ok: true, settings, ...buildFinance(raw, month, today, settings) });
}

// ── Pemasukan ──
async function handleIncomePost(request, env, user) {
  let b;
  try { b = await request.json(); } catch { return fail("JSON tidak valid"); }

  const month = String(b.month ?? "").slice(0, 7);
  if (!isValidMonth(month)) return fail("Bulan harus format YYYY-MM");
  const label = String(b.label ?? "").trim().slice(0, 80);
  if (!label) return fail("Label pemasukan wajib diisi");
  const amount = Number(b.amount);
  if (!isFinite(amount) || amount <= 0) return fail("Jumlah pemasukan tidak valid");
  const category = INCOME_CATS.includes(b.category) ? b.category : "lainnya";
  const note = b.note ? String(b.note).slice(0, 200) : null;

  if (b.id) {
    await env.DB.prepare(
      `UPDATE incomes SET month=?, label=?, amount=?, category=?, note=?
        WHERE id=? AND user_id=?`
    ).bind(month, label, round2(amount), category, note, Number(b.id), user.id).run();
    return json({ ok: true, id: Number(b.id) });
  }

  const res = await env.DB.prepare(
    `INSERT INTO incomes (user_id, month, label, amount, category, note) VALUES (?,?,?,?,?,?)`
  ).bind(user.id, month, label, round2(amount), category, note).run();

  return json({ ok: true, id: res.meta?.last_row_id ?? null });
}

// ── Hutang ──
async function handleDebtPost(request, env, user) {
  let b;
  try { b = await request.json(); } catch { return fail("JSON tidak valid"); }

  const label = String(b.label ?? "").trim().slice(0, 80);
  if (!label) return fail("Label hutang wajib diisi");
  const total = Number(b.total_amount);
  if (!isFinite(total) || total <= 0) return fail("Total hutang tidak valid");
  const inst = Number(b.monthly_installment);
  if (!isFinite(inst) || inst <= 0) return fail("Cicilan per bulan tidak valid");
  if (inst > total) return fail("Cicilan per bulan melebihi total hutang");

  const dueDay = b.due_day == null || b.due_day === "" ? null : Number(b.due_day);
  if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31))
    return fail("Tanggal jatuh tempo harus 1–31");

  const finalDue = b.final_due_date ? String(b.final_due_date).slice(0, 10) : null;
  if (finalDue && !isValidDate(finalDue)) return fail("Tanggal lunas harus YYYY-MM-DD");

  const startMonth = b.start_month ? String(b.start_month).slice(0, 7) : null;
  if (startMonth && !isValidMonth(startMonth)) return fail("Bulan mulai harus YYYY-MM");

  const status = b.status === "lunas" ? "lunas" : "aktif";
  const note = b.note ? String(b.note).slice(0, 200) : null;

  if (b.id) {
    await env.DB.prepare(
      `UPDATE debts SET label=?, total_amount=?, monthly_installment=?, due_day=?,
                        final_due_date=?, start_month=?, status=?, note=?,
                        updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND user_id=?`
    ).bind(label, round2(total), round2(inst), dueDay, finalDue, startMonth, status, note, Number(b.id), user.id).run();
    return json({ ok: true, id: Number(b.id) });
  }

  const res = await env.DB.prepare(
    `INSERT INTO debts (user_id, label, total_amount, monthly_installment, due_day,
                        final_due_date, start_month, status, note)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(user.id, label, round2(total), round2(inst), dueDay, finalDue, startMonth, status, note).run();

  return json({ ok: true, id: res.meta?.last_row_id ?? null });
}

async function handleDebtPay(request, env, user) {
  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const debtId = Number(url.searchParams.get("debt_id"));
    const month = url.searchParams.get("month") ?? "";
    if (!debtId || !isValidMonth(month)) return fail("debt_id dan month wajib diisi");
    const settings = await readSettings(env, user.id);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const autoOn = Number(settings.auto_pay_past) !== 0;

    if (autoOn && month < currentMonth) {
      // Simpan penanda amount 0 supaya backfill tidak mengisinya lagi
      await env.DB.prepare(
        `INSERT INTO debt_payments (user_id, debt_id, month, amount, auto) VALUES (?,?,?,0,2)
         ON CONFLICT(debt_id, month) DO UPDATE SET amount = 0, auto = 2,
                                                   paid_at = CURRENT_TIMESTAMP`
      ).bind(user.id, debtId, month).run();
      await syncDebtStatus(env, debtId, user.id);
      return json({ ok: true, marked: "belum_bayar" });
    }

    const res = await env.DB.prepare(
      "DELETE FROM debt_payments WHERE debt_id = ? AND month = ? AND user_id = ?"
    ).bind(debtId, month, user.id).run();
    if (!(res.meta?.changes ?? 0)) return fail("Pembayaran tidak ditemukan", 404);
    await syncDebtStatus(env, debtId, user.id);
    return json({ ok: true });
  }

  let b;
  try { b = await request.json(); } catch { return fail("JSON tidak valid"); }

  const debtId = Number(b.debt_id);
  const month = String(b.month ?? "").slice(0, 7);
  if (!debtId) return fail("debt_id wajib diisi");
  if (!isValidMonth(month)) return fail("Bulan harus format YYYY-MM");

  const debt = await env.DB.prepare(
    "SELECT * FROM debts WHERE id = ? AND user_id = ?"
  ).bind(debtId, user.id).first();
  if (!debt) return fail("Hutang tidak ditemukan", 404);

  let amount = Number(b.amount);
  if (!isFinite(amount) || amount <= 0) amount = debt.monthly_installment;

  await env.DB.prepare(
    `INSERT INTO debt_payments (user_id, debt_id, month, amount, auto) VALUES (?,?,?,?,0)
     ON CONFLICT(debt_id, month) DO UPDATE SET amount = excluded.amount,
                                               auto = 0,
                                               paid_at = CURRENT_TIMESTAMP`
  ).bind(user.id, debtId, month, round2(amount)).run();

  await syncDebtStatus(env, debtId, user.id);

  const sum = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount),0) AS paid FROM debt_payments WHERE debt_id = ? AND user_id = ?"
  ).bind(debtId, user.id).first();

  return json({ ok: true, paid_total: round2(sum?.paid ?? 0) });
}

// ── Pengeluaran ──
async function handleExpensePost(request, env, user) {
  let b;
  try { b = await request.json(); } catch { return fail("JSON tidak valid"); }

  const label = String(b.label ?? "").trim().slice(0, 80);
  if (!label) return fail("Label pengeluaran wajib diisi");
  const amount = Number(b.amount);
  if (!isFinite(amount) || amount <= 0) return fail("Nominal pengeluaran tidak valid");

  const type = b.type === "sekali" ? "sekali" : "rutin";
  const category = EXPENSE_CATS.includes(b.category) ? b.category : "lainnya";

  let month = null, startMonth = null, endMonth = null;
  if (type === "sekali") {
    month = String(b.month ?? "").slice(0, 7);
    if (!isValidMonth(month)) return fail("Bulan pengeluaran harus YYYY-MM");
  } else {
    startMonth = b.start_month ? String(b.start_month).slice(0, 7) : null;
    endMonth = b.end_month ? String(b.end_month).slice(0, 7) : null;
    if (startMonth && !isValidMonth(startMonth)) return fail("Bulan mulai harus YYYY-MM");
    if (endMonth && !isValidMonth(endMonth)) return fail("Bulan selesai harus YYYY-MM");
    if (startMonth && endMonth && endMonth < startMonth)
      return fail("Bulan selesai lebih awal dari bulan mulai");
  }

  const dueDay = b.due_day == null || b.due_day === "" ? null : Number(b.due_day);
  if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31))
    return fail("Tanggal tagihan harus 1–31");

  const note = b.note ? String(b.note).slice(0, 200) : null;

  if (b.id) {
    await env.DB.prepare(
      `UPDATE expenses SET label=?, amount=?, category=?, type=?, month=?,
                           start_month=?, end_month=?, due_day=?, note=?
        WHERE id=? AND user_id=?`
    ).bind(label, round2(amount), category, type, month, startMonth, endMonth, dueDay, note, Number(b.id), user.id).run();
    return json({ ok: true, id: Number(b.id) });
  }

  const res = await env.DB.prepare(
    `INSERT INTO expenses (user_id, label, amount, category, type, month, start_month, end_month, due_day, note)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(user.id, label, round2(amount), category, type, month, startMonth, endMonth, dueDay, note).run();

  return json({ ok: true, id: res.meta?.last_row_id ?? null });
}

// ── Penarikan dari akun trading ──
async function handleWithdrawalPost(request, env, user) {
  let b;
  try { b = await request.json(); } catch { return fail("JSON tidak valid"); }

  const date = String(b.date ?? "").slice(0, 10);
  if (!isValidDate(date)) return fail("Tanggal penarikan harus YYYY-MM-DD");

  const usd = Number(b.amount_usd);
  if (!isFinite(usd) || usd <= 0) return fail("Nominal penarikan tidak valid");

  const settings = await readSettings(env, user.id);
  let rate = Number(b.rate);
  if (!isFinite(rate) || rate <= 0) {
    rate = settings.currency === settings.finance_currency
      ? 1
      : Number(settings.usd_rate) || 1;
  }

  const amount = round2(usd * rate);
  const note = b.note ? String(b.note).slice(0, 200) : null;

  if (b.id) {
    await env.DB.prepare(
      `UPDATE withdrawals SET date=?, amount_usd=?, rate=?, amount=?, note=?
        WHERE id=? AND user_id=?`
    ).bind(date, round2(usd), round2(rate), amount, note, Number(b.id), user.id).run();
    return json({ ok: true, id: Number(b.id), amount });
  }

  const res = await env.DB.prepare(
    `INSERT INTO withdrawals (user_id, date, amount_usd, rate, amount, note) VALUES (?,?,?,?,?,?)`
  ).bind(user.id, date, round2(usd), round2(rate), amount, note).run();

  return json({ ok: true, id: res.meta?.last_row_id ?? null, amount });
}

/** DELETE generik untuk incomes / debts / expenses / withdrawals */
async function handleFinanceDelete(request, env, table, user) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!id) return fail("Parameter id wajib diisi");

  if (table === "debts") {
    await env.DB.prepare(
      "DELETE FROM debt_payments WHERE debt_id = ? AND user_id = ?"
    ).bind(id, user.id).run();
  }

  const res = await env.DB.prepare(
    `DELETE FROM ${table} WHERE id = ? AND user_id = ?`
  ).bind(id, user.id).run();
  if (!(res.meta?.changes ?? 0)) return fail("Data tidak ditemukan", 404);
  return json({ ok: true, deleted: id });
}

// ─────────────────────────────────────────────────────────
//  ROUTER
// ─────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    try {
      // ── Endpoint publik ──
      if (path === "/" || path === "/health") {
        return json({
          ok: true,
          service: "SKFaq · Jurnal Trading & Keuangan",
          version: "4.0.2",
          features: ["jurnal", "keuangan", "carry_over", "auto_pay_past",
                     "jadwal_cicilan", "penarikan_di_jurnal", "ekuitas_efektif",
                     "jurnal_idr", "multi_user"],
          timestamp: new Date().toISOString(),
        });
      }

      if (path === "/api/auth/status" && method === "GET") {
        return json({ ok: true, needs_setup: (await userCount(env)) === 0 });
      }

      if (path === "/api/auth/register" && method === "POST") return await handleRegister(request, env);
      if (path === "/api/auth/login" && method === "POST") return await handleLogin(request, env);

      // ── Mulai sini wajib login ──
      const user = await authUser(request, env);
      if (!user) return fail("Sesi tidak valid atau sudah berakhir", 401);

      if (path === "/api/auth/me" && method === "GET") {
        return json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
      }
      if (path === "/api/auth/logout" && method === "POST") return await handleLogout(request, env, user);
      if (path === "/api/auth/password" && method === "POST") return await handlePasswordChange(request, env, user);

      if (path === "/api/summary" && method === "GET") return await handleSummary(request, env, user);

      if (path === "/api/entries") {
        if (method === "GET") return await handleEntriesGet(request, env, user);
        if (method === "POST") return await handleEntryPost(request, env, user);
        if (method === "DELETE") return await handleEntryDelete(request, env, user);
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/finance" && method === "GET") return await handleFinance(request, env, user);

      if (path === "/api/finance/income") {
        if (method === "POST") return await handleIncomePost(request, env, user);
        if (method === "DELETE") return await handleFinanceDelete(request, env, "incomes", user);
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/finance/debt") {
        if (method === "POST") return await handleDebtPost(request, env, user);
        if (method === "DELETE") return await handleFinanceDelete(request, env, "debts", user);
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/finance/debt/pay") {
        if (method === "POST" || method === "DELETE") return await handleDebtPay(request, env, user);
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/finance/withdrawal") {
        if (method === "POST") return await handleWithdrawalPost(request, env, user);
        if (method === "DELETE") return await handleFinanceDelete(request, env, "withdrawals", user);
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/finance/expense") {
        if (method === "POST") return await handleExpensePost(request, env, user);
        if (method === "DELETE") return await handleFinanceDelete(request, env, "expenses", user);
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/settings") {
        if (method === "GET") return json({ ok: true, settings: await readSettings(env, user.id) });
        if (method === "POST") return await handleSettingsPost(request, env, user);
        return fail("Method tidak didukung", 405);
      }

      return fail("Not found", 404);
    } catch (e) {
      console.error("Router error:", e && e.message);
      return fail(`Server error: ${e && e.message}`, 500);
    }
  },
};

