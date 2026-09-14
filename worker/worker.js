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
  "Access-Control-Allow-Headers": "Content-Type",
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

// ─────────────────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────────────────
const SETTING_KEYS = ["initial_capital", "monthly_target", "currency"];

async function readSettings(env) {
  const res = await env.DB.prepare("SELECT key, value FROM settings").all();
  const out = { initial_capital: 0, monthly_target: 0, currency: "USD" };
  for (const row of res.results ?? []) {
    if (row.key === "currency") out.currency = row.value;
    else out[row.key] = Number(row.value) || 0;
  }
  return out;
}

async function handleSettingsPost(request, env) {
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
    if (key !== "currency") {
      const num = Number(value);
      if (!isFinite(num) || num < 0) return fail(`Nilai ${key} tidak valid`);
      value = String(num);
    } else {
      value = String(value).slice(0, 8).toUpperCase();
    }
    writes.push(
      env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                        updated_at = CURRENT_TIMESTAMP`
      ).bind(key, value)
    );
  }

  if (writes.length) await env.DB.batch(writes);
  return json({ ok: true, settings: await readSettings(env) });
}

// ─────────────────────────────────────────────────────────
//  ENTRIES
// ─────────────────────────────────────────────────────────
async function allEntries(env) {
  const res = await env.DB.prepare(
    `SELECT date, start_balance, end_balance, note, updated_at
       FROM daily_entries
      ORDER BY date ASC`
  ).all();

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

async function handleEntriesGet(request, env) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = Math.min(parseInt(url.searchParams.get("limit")) || 500, 2000);

  let entries = await allEntries(env);
  if (from && isValidDate(from)) entries = entries.filter((e) => e.date >= from);
  if (to && isValidDate(to)) entries = entries.filter((e) => e.date <= to);
  if (entries.length > limit) entries = entries.slice(-limit);

  return json({ ok: true, entries, count: entries.length });
}

async function handleEntryPost(request, env) {
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
    `INSERT INTO daily_entries (date, start_balance, end_balance, note)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       start_balance = excluded.start_balance,
       end_balance   = excluded.end_balance,
       note          = excluded.note,
       updated_at    = CURRENT_TIMESTAMP`
  )
    .bind(date, round2(start), round2(end), note)
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

async function handleEntryDelete(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  if (!isValidDate(date)) return fail("Format tanggal harus YYYY-MM-DD");

  const res = await env.DB.prepare("DELETE FROM daily_entries WHERE date = ?")
    .bind(date)
    .run();

  const removed = res.meta?.changes ?? 0;
  if (!removed) return fail("Entry tidak ditemukan", 404);
  return json({ ok: true, deleted: date });
}

// ─────────────────────────────────────────────────────────
//  STATISTIK
// ─────────────────────────────────────────────────────────
function computeStats(entries, settings, today) {
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
  };

  if (!entries.length) return base;

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
  let peak = entries[0].start_balance;
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

    peak = Math.max(peak, e.end_balance);
    const ddAmount = peak - e.end_balance;
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
  };
}

async function handleSummary(request, env) {
  const url = new URL(request.url);
  let today = url.searchParams.get("today") ?? "";
  if (!isValidDate(today)) today = new Date().toISOString().slice(0, 10);

  const [settings, entries] = await Promise.all([readSettings(env), allEntries(env)]);
  const stats = computeStats(entries, settings, today);

  return json({
    ok: true,
    today,
    settings,
    stats,
    entries,
    server_time: new Date().toISOString(),
  });
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
      if (path === "/api/summary" && method === "GET") return await handleSummary(request, env);

      if (path === "/api/entries") {
        if (method === "GET") return await handleEntriesGet(request, env);
        if (method === "POST") return await handleEntryPost(request, env);
        if (method === "DELETE") return await handleEntryDelete(request, env);
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/settings") {
        if (method === "GET") return json({ ok: true, settings: await readSettings(env) });
        if (method === "POST") return await handleSettingsPost(request, env);
        return fail("Method tidak didukung", 405);
      }

      if (path === "/" || path === "/health") {
        return json({
          ok: true,
          service: "SKFaq · Jurnal Trading Harian",
          version: "2.0.0",
          timestamp: new Date().toISOString(),
        });
      }

      return fail("Not found", 404);
    } catch (e) {
      console.error("Router error:", e && e.message);
      return fail(`Server error: ${e && e.message}`, 500);
    }
  },
};

