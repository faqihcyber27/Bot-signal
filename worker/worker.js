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
const SETTING_KEYS = ["initial_capital", "monthly_target", "currency", "finance_currency"];
const STRING_SETTINGS = ["currency", "finance_currency"];

async function readSettings(env) {
  const res = await env.DB.prepare("SELECT key, value FROM settings").all();
  const out = { initial_capital: 0, monthly_target: 0, currency: "USD", finance_currency: "IDR" };
  for (const row of res.results ?? []) {
    if (STRING_SETTINGS.includes(row.key)) out[row.key] = row.value;
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
    if (STRING_SETTINGS.includes(key)) {
      value = String(value).slice(0, 8).toUpperCase();
    } else {
      const num = Number(value);
      if (!isFinite(num) || num < 0) return fail(`Nilai ${key} tidak valid`);
      value = String(num);
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

const expenseAppliesTo = (e, month) =>
  e.type === "rutin"
    ? (!e.start_month || e.start_month <= month) && (!e.end_month || e.end_month >= month)
    : e.month === month;

async function loadFinanceRaw(env) {
  const [inc, debts, pays, exp, trading] = await Promise.all([
    env.DB.prepare("SELECT * FROM incomes ORDER BY month DESC, id DESC").all(),
    env.DB.prepare("SELECT * FROM debts ORDER BY id ASC").all(),
    env.DB.prepare("SELECT * FROM debt_payments").all(),
    env.DB.prepare("SELECT * FROM expenses ORDER BY id ASC").all(),
    env.DB.prepare(
      `SELECT substr(date,1,7) AS month,
              COALESCE(SUM(end_balance - start_balance),0) AS pnl,
              COUNT(*) AS days
         FROM daily_entries GROUP BY substr(date,1,7)`
    ).all(),
  ]);

  return {
    incomes: inc.results ?? [],
    debts: debts.results ?? [],
    payments: pays.results ?? [],
    expenses: exp.results ?? [],
    trading: trading.results ?? [],
  };
}

function buildFinance(raw, month, today) {
  const paidByDebt = new Map();
  const paidByKey = new Map();
  for (const p of raw.payments) {
    paidByDebt.set(p.debt_id, (paidByDebt.get(p.debt_id) || 0) + p.amount);
    paidByKey.set(p.debt_id + "|" + p.month, p);
  }

  // ── Hutang diperkaya ──
  const debts = raw.debts.map((d) => {
    const paid = round2(paidByDebt.get(d.id) || 0);
    const remaining = Math.max(round2(d.total_amount - paid), 0);
    const lunas = d.status === "lunas" || remaining <= 0.009;
    const dueThis = dueDateIn(month, d.due_day);
    const paidThisMonth = paidByKey.has(d.id + "|" + month);
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
      paid_amount: paid,
      remaining,
      progress_pct: d.total_amount > 0 ? round2((paid / d.total_amount) * 100) : 0,
      months_left:
        d.monthly_installment > 0 ? Math.ceil(remaining / d.monthly_installment) : null,
      installments_paid: raw.payments.filter((p) => p.debt_id === d.id).length,
      due_date_this_month: dueThis,
      days_to_due: daysBetween(today, dueThis),
      paid_this_month: paidThisMonth,
      due_this_month: activeThisMonth ? round2(Math.min(d.monthly_installment, remaining)) : 0,
      active_this_month: activeThisMonth,
    };
  });

  // ── Agregat satu bulan ──
  function agg(m) {
    const income = raw.incomes
      .filter((i) => i.month === m)
      .reduce((a, i) => a + i.amount, 0);

    const installment = debts.reduce((a, d) => {
      if (d.status === "lunas") return a;
      if (d.start_month && d.start_month > m) return a;
      if (d.final_due_date && d.final_due_date.slice(0, 7) < m) return a;
      return a + d.monthly_installment;
    }, 0);

    const applicable = raw.expenses.filter((e) => expenseAppliesTo(e, m));
    const rutin = applicable.filter((e) => e.type === "rutin").reduce((a, e) => a + e.amount, 0);
    const sekali = applicable.filter((e) => e.type !== "rutin").reduce((a, e) => a + e.amount, 0);
    const outflow = installment + rutin + sekali;

    return {
      month: m,
      income: round2(income),
      installment: round2(installment),
      expense_rutin: round2(rutin),
      expense_sekali: round2(sekali),
      expense_total: round2(rutin + sekali),
      outflow: round2(outflow),
      buffer: round2(income - outflow),
    };
  }

  const cur = agg(month);
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

  const trend = [];
  for (let i = 5; i >= 0; i--) trend.push(agg(monthShift(month, -i)));

  return {
    month,
    today,
    summary: {
      income_total: cur.income,
      installment_total: cur.installment,
      installment_paid: round2(
        debts.filter((d) => d.paid_this_month).reduce((a, d) => a + d.monthly_installment, 0)
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
      daily_allowance: round2(Math.max(cur.buffer, 0) / daysLeft),
      days_left: daysLeft,
      days_in_month: dim,
      is_current_month: isCurrentMonth,
      expense_by_category,
      trading_pnl: round2(tradingRow ? tradingRow.pnl : 0),
      trading_days: tradingRow ? tradingRow.days : 0,
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
    trend,
  };
}

async function handleFinance(request, env) {
  const url = new URL(request.url);
  let month = url.searchParams.get("month") ?? "";
  let today = url.searchParams.get("today") ?? "";
  if (!isValidDate(today)) today = new Date().toISOString().slice(0, 10);
  if (!isValidMonth(month)) month = today.slice(0, 7);

  const [raw, settings] = await Promise.all([loadFinanceRaw(env), readSettings(env)]);
  return json({ ok: true, settings, ...buildFinance(raw, month, today) });
}

// ── Pemasukan ──
async function handleIncomePost(request, env) {
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
      `UPDATE incomes SET month=?, label=?, amount=?, category=?, note=? WHERE id=?`
    ).bind(month, label, round2(amount), category, note, Number(b.id)).run();
    return json({ ok: true, id: Number(b.id) });
  }

  const res = await env.DB.prepare(
    `INSERT INTO incomes (month, label, amount, category, note) VALUES (?,?,?,?,?)`
  ).bind(month, label, round2(amount), category, note).run();

  return json({ ok: true, id: res.meta?.last_row_id ?? null });
}

// ── Hutang ──
async function handleDebtPost(request, env) {
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
        WHERE id=?`
    ).bind(label, round2(total), round2(inst), dueDay, finalDue, startMonth, status, note, Number(b.id)).run();
    return json({ ok: true, id: Number(b.id) });
  }

  const res = await env.DB.prepare(
    `INSERT INTO debts (label, total_amount, monthly_installment, due_day,
                        final_due_date, start_month, status, note)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(label, round2(total), round2(inst), dueDay, finalDue, startMonth, status, note).run();

  return json({ ok: true, id: res.meta?.last_row_id ?? null });
}

async function handleDebtPay(request, env) {
  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const debtId = Number(url.searchParams.get("debt_id"));
    const month = url.searchParams.get("month") ?? "";
    if (!debtId || !isValidMonth(month)) return fail("debt_id dan month wajib diisi");
    const res = await env.DB.prepare(
      "DELETE FROM debt_payments WHERE debt_id = ? AND month = ?"
    ).bind(debtId, month).run();
    if (!(res.meta?.changes ?? 0)) return fail("Pembayaran tidak ditemukan", 404);
    return json({ ok: true });
  }

  let b;
  try { b = await request.json(); } catch { return fail("JSON tidak valid"); }

  const debtId = Number(b.debt_id);
  const month = String(b.month ?? "").slice(0, 7);
  if (!debtId) return fail("debt_id wajib diisi");
  if (!isValidMonth(month)) return fail("Bulan harus format YYYY-MM");

  const debt = await env.DB.prepare("SELECT * FROM debts WHERE id = ?").bind(debtId).first();
  if (!debt) return fail("Hutang tidak ditemukan", 404);

  let amount = Number(b.amount);
  if (!isFinite(amount) || amount <= 0) amount = debt.monthly_installment;

  await env.DB.prepare(
    `INSERT INTO debt_payments (debt_id, month, amount) VALUES (?,?,?)
     ON CONFLICT(debt_id, month) DO UPDATE SET amount = excluded.amount,
                                               paid_at = CURRENT_TIMESTAMP`
  ).bind(debtId, month, round2(amount)).run();

  // Tandai lunas otomatis bila akumulasi pembayaran menutup total hutang
  const sum = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount),0) AS paid FROM debt_payments WHERE debt_id = ?"
  ).bind(debtId).first();

  if ((sum?.paid ?? 0) >= debt.total_amount - 0.009) {
    await env.DB.prepare(
      "UPDATE debts SET status='lunas', updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(debtId).run();
  }

  return json({ ok: true, paid_total: round2(sum?.paid ?? 0) });
}

// ── Pengeluaran ──
async function handleExpensePost(request, env) {
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
        WHERE id=?`
    ).bind(label, round2(amount), category, type, month, startMonth, endMonth, dueDay, note, Number(b.id)).run();
    return json({ ok: true, id: Number(b.id) });
  }

  const res = await env.DB.prepare(
    `INSERT INTO expenses (label, amount, category, type, month, start_month, end_month, due_day, note)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(label, round2(amount), category, type, month, startMonth, endMonth, dueDay, note).run();

  return json({ ok: true, id: res.meta?.last_row_id ?? null });
}

/** DELETE generik untuk incomes / debts / expenses */
async function handleFinanceDelete(request, env, table) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!id) return fail("Parameter id wajib diisi");

  if (table === "debts") {
    await env.DB.prepare("DELETE FROM debt_payments WHERE debt_id = ?").bind(id).run();
  }

  const res = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
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
      if (path === "/api/summary" && method === "GET") return await handleSummary(request, env);

      if (path === "/api/entries") {
        if (method === "GET") return await handleEntriesGet(request, env);
        if (method === "POST") return await handleEntryPost(request, env);
        if (method === "DELETE") return await handleEntryDelete(request, env);
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/finance" && method === "GET") return await handleFinance(request, env);

      if (path === "/api/finance/income") {
        if (method === "POST") return await handleIncomePost(request, env);
        if (method === "DELETE") return await handleFinanceDelete(request, env, "incomes");
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/finance/debt") {
        if (method === "POST") return await handleDebtPost(request, env);
        if (method === "DELETE") return await handleFinanceDelete(request, env, "debts");
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/finance/debt/pay") {
        if (method === "POST" || method === "DELETE") return await handleDebtPay(request, env);
        return fail("Method tidak didukung", 405);
      }

      if (path === "/api/finance/expense") {
        if (method === "POST") return await handleExpensePost(request, env);
        if (method === "DELETE") return await handleFinanceDelete(request, env, "expenses");
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

