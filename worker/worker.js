/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  XAUUSD AI Signal Engine — Cloudflare Worker API          ║
 * ║                                                            ║
 * ║  Endpoints:                                                ║
 * ║    POST /sync               — Receive data from VPS        ║
 * ║    GET  /api/overview       — Dashboard summary stats      ║
 * ║    GET  /api/signals        — Recent signals list          ║
 * ║    GET  /api/trades         — Recent trades list           ║
 * ║    GET  /api/equity         — Equity curve data            ║
 * ║    GET  /api/tiers          — Performance per tier         ║
 * ║    GET  /api/status         — Live system status           ║
 * ║    GET  /api/distribution   — Outcome distribution         ║
 * ║    GET  /                   — Health check                 ║
 * ║                                                            ║
 * ║  Auth: Bearer token on /sync only (read endpoints public)  ║
 * ╚═══════════════════════════════════════════════════════════╝
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });

const error = (msg, status = 400) => json({ error: msg }, status);

// ─────────────────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────────────────
async function authSync(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const token = auth.replace("Bearer ", "").trim();
  return token === env.SYNC_TOKEN;
}

// ─────────────────────────────────────────────────────────
//  POST /sync — Receive batch update from VPS
// ─────────────────────────────────────────────────────────
async function handleSync(request, env) {
  if (!(await authSync(request, env))) {
    return error("Unauthorized", 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON", 400);
  }

  const synced = { signals: 0, trades: 0, status: 0, snapshot: 0 };

  try {
    // ── SIGNALS upsert ──
    if (Array.isArray(body.signals) && body.signals.length > 0) {
      for (const s of body.signals) {
        await env.DB.prepare(
          `INSERT INTO signals (
            id, timestamp, mode, tier, score, direction, confidence,
            entry_price, stop_loss, take_profit_1, take_profit_2,
            risk_reward, reasoning_summary, outcome, outcome_pnl, closed_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            outcome=excluded.outcome,
            outcome_pnl=excluded.outcome_pnl,
            closed_at=excluded.closed_at,
            synced_at=CURRENT_TIMESTAMP`
        )
          .bind(
            s.id, s.timestamp, s.mode, s.tier, s.score, s.direction,
            s.confidence ?? null,
            s.entry_price ?? null, s.stop_loss ?? null,
            s.take_profit_1 ?? null, s.take_profit_2 ?? null,
            s.risk_reward ?? null, s.reasoning_summary ?? null,
            s.outcome ?? null, s.outcome_pnl ?? null, s.closed_at ?? null
          )
          .run();
        synced.signals++;
      }
    }

    // ── TRADES upsert ──
    if (Array.isArray(body.trades) && body.trades.length > 0) {
      for (const t of body.trades) {
        await env.DB.prepare(
          `INSERT INTO trades (
            id, signal_id, ticket, direction, lot, entry_price,
            stop_loss, take_profit_1, take_profit_2, opened_at,
            tp1_hit, closed, closed_at, close_reason, profit_loss
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(ticket) DO UPDATE SET
            tp1_hit=excluded.tp1_hit,
            closed=excluded.closed,
            closed_at=excluded.closed_at,
            close_reason=excluded.close_reason,
            profit_loss=excluded.profit_loss,
            synced_at=CURRENT_TIMESTAMP`
        )
          .bind(
            t.id, t.signal_id ?? null, t.ticket, t.direction, t.lot,
            t.entry_price, t.stop_loss, t.take_profit_1, t.take_profit_2,
            t.opened_at,
            t.tp1_hit ? 1 : 0, t.closed ? 1 : 0,
            t.closed_at ?? null, t.close_reason ?? null, t.profit_loss ?? null
          )
          .run();
        synced.trades++;
      }
    }

    // ── SYSTEM STATUS upsert (id=1) ──
    if (body.status) {
      const s = body.status;
      await env.DB.prepare(
        `INSERT INTO system_status (
          id, auto_mode, balance, equity, peak_balance,
          open_positions, daily_pl, daily_pl_pct, drawdown_pct,
          consec_losses, kill_switch_active, manual_paused,
          last_signal_at, updated_at
        ) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          auto_mode=excluded.auto_mode,
          balance=excluded.balance,
          equity=excluded.equity,
          peak_balance=excluded.peak_balance,
          open_positions=excluded.open_positions,
          daily_pl=excluded.daily_pl,
          daily_pl_pct=excluded.daily_pl_pct,
          drawdown_pct=excluded.drawdown_pct,
          consec_losses=excluded.consec_losses,
          kill_switch_active=excluded.kill_switch_active,
          manual_paused=excluded.manual_paused,
          last_signal_at=excluded.last_signal_at,
          updated_at=CURRENT_TIMESTAMP`
      )
        .bind(
          s.auto_mode ?? null, s.balance ?? null, s.equity ?? null,
          s.peak_balance ?? null, s.open_positions ?? 0,
          s.daily_pl ?? 0, s.daily_pl_pct ?? 0,
          s.drawdown_pct ?? 0, s.consec_losses ?? 0,
          s.kill_switch_active ? 1 : 0,
          s.manual_paused ? 1 : 0,
          s.last_signal_at ?? null
        )
        .run();
      synced.status = 1;
    }

    // ── DAILY SNAPSHOT upsert ──
    if (body.snapshot) {
      const sn = body.snapshot;
      await env.DB.prepare(
        `INSERT INTO daily_snapshots (
          date, start_balance, end_balance, peak_balance,
          trades_count, wins_count, losses_count, total_pnl
        ) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(date) DO UPDATE SET
          end_balance=excluded.end_balance,
          peak_balance=excluded.peak_balance,
          trades_count=excluded.trades_count,
          wins_count=excluded.wins_count,
          losses_count=excluded.losses_count,
          total_pnl=excluded.total_pnl,
          synced_at=CURRENT_TIMESTAMP`
      )
        .bind(
          sn.date, sn.start_balance,
          sn.end_balance ?? null, sn.peak_balance ?? null,
          sn.trades_count ?? 0, sn.wins_count ?? 0,
          sn.losses_count ?? 0, sn.total_pnl ?? 0
        )
        .run();
      synced.snapshot = 1;
    }

    return json({ ok: true, synced });
  } catch (e) {
    console.error("Sync error:", e.message);
    return error(`Sync failed: ${e.message}`, 500);
  }
}

// ─────────────────────────────────────────────────────────
//  GET /api/overview — Dashboard summary
// ─────────────────────────────────────────────────────────
async function handleOverview(env) {
  try {
    const [statusRes, sigRes, tradeRes, pfRes] = await Promise.all([
      env.DB.prepare("SELECT * FROM system_status WHERE id = 1").first(),

      env.DB.prepare(
        `SELECT 
          COUNT(*) AS total,
          SUM(CASE WHEN outcome IN ('TP1','TP2') THEN 1 ELSE 0 END) AS tp_hits,
          SUM(CASE WHEN outcome = 'TP1' THEN 1 ELSE 0 END) AS tp1_hits,
          SUM(CASE WHEN outcome = 'TP2' THEN 1 ELSE 0 END) AS tp2_hits,
          SUM(CASE WHEN outcome = 'SL' THEN 1 ELSE 0 END) AS sl_hits,
          SUM(CASE WHEN outcome = 'BE' THEN 1 ELSE 0 END) AS be_hits
        FROM signals
        WHERE timestamp >= datetime('now','-30 days')
          AND outcome IS NOT NULL`
      ).first(),

      env.DB.prepare(
        `SELECT 
          COUNT(*) AS total,
          SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN profit_loss < 0 THEN 1 ELSE 0 END) AS losses,
          COALESCE(SUM(profit_loss),0) AS total_pnl,
          COALESCE(AVG(profit_loss),0) AS avg_pnl,
          COALESCE(MAX(profit_loss),0) AS best_trade,
          COALESCE(MIN(profit_loss),0) AS worst_trade
        FROM trades
        WHERE opened_at >= datetime('now','-30 days')
          AND closed = 1`
      ).first(),

      env.DB.prepare(
        `SELECT 
          COALESCE(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END),0) AS gross_profit,
          COALESCE(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)),0) AS gross_loss
        FROM trades
        WHERE closed = 1 AND opened_at >= datetime('now','-30 days')`
      ).first(),
    ]);

    const totalOutcomes = (sigRes.tp_hits ?? 0) + (sigRes.sl_hits ?? 0);
    const winRate = totalOutcomes > 0 ? (sigRes.tp_hits / totalOutcomes) * 100 : 0;
    const profitFactor =
      pfRes.gross_loss > 0 ? pfRes.gross_profit / pfRes.gross_loss : 0;

    return json({
      status: statusRes ?? {},
      stats: {
        period_days: 30,
        total_signals: sigRes.total ?? 0,
        tp_hits: sigRes.tp_hits ?? 0,
        tp1_hits: sigRes.tp1_hits ?? 0,
        tp2_hits: sigRes.tp2_hits ?? 0,
        sl_hits: sigRes.sl_hits ?? 0,
        be_hits: sigRes.be_hits ?? 0,
        win_rate: Math.round(winRate * 10) / 10,
        profit_factor: Math.round(profitFactor * 100) / 100,
        total_trades: tradeRes.total ?? 0,
        trades_won: tradeRes.wins ?? 0,
        trades_lost: tradeRes.losses ?? 0,
        total_pnl: tradeRes.total_pnl ?? 0,
        avg_pnl: tradeRes.avg_pnl ?? 0,
        best_trade: tradeRes.best_trade ?? 0,
        worst_trade: tradeRes.worst_trade ?? 0,
      },
    });
  } catch (e) {
    return error(`Overview failed: ${e.message}`, 500);
  }
}

// ─────────────────────────────────────────────────────────
//  GET /api/signals
// ─────────────────────────────────────────────────────────
async function handleSignals(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit")) || 50, 200);
  const tier = url.searchParams.get("tier");

  try {
    let query = "SELECT * FROM signals";
    const params = [];
    if (tier) {
      query += " WHERE tier = ?";
      params.push(tier);
    }
    query += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);

    const result = await env.DB.prepare(query).bind(...params).all();
    return json({ signals: result.results ?? [] });
  } catch (e) {
    return error(e.message, 500);
  }
}

// ─────────────────────────────────────────────────────────
//  GET /api/trades
// ─────────────────────────────────────────────────────────
async function handleTrades(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit")) || 50, 200);
  const status = url.searchParams.get("status");

  try {
    let query = "SELECT * FROM trades";
    if (status === "open") query += " WHERE closed = 0";
    else if (status === "closed") query += " WHERE closed = 1";
    query += ` ORDER BY opened_at DESC LIMIT ?`;

    const result = await env.DB.prepare(query).bind(limit).all();
    return json({ trades: result.results ?? [] });
  } catch (e) {
    return error(e.message, 500);
  }
}

// ─────────────────────────────────────────────────────────
//  GET /api/equity — Equity curve
// ─────────────────────────────────────────────────────────
async function handleEquity(request, env) {
  const url = new URL(request.url);
  const days = Math.min(parseInt(url.searchParams.get("days")) || 30, 365);

  try {
    const result = await env.DB.prepare(
      `SELECT date, start_balance, end_balance, peak_balance, total_pnl, trades_count
       FROM daily_snapshots
       WHERE date >= date('now','-' || ? || ' days')
       ORDER BY date ASC`
    )
      .bind(days)
      .all();

    return json({ equity: result.results ?? [] });
  } catch (e) {
    return error(e.message, 500);
  }
}

// ─────────────────────────────────────────────────────────
//  GET /api/tiers — Performance per tier
// ─────────────────────────────────────────────────────────
async function handleTiers(env) {
  try {
    const result = await env.DB.prepare(
      `SELECT
        tier,
        COUNT(*) AS count,
        SUM(CASE WHEN outcome IN ('TP1','TP2') THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN outcome = 'SL' THEN 1 ELSE 0 END) AS losses,
        COALESCE(SUM(outcome_pnl),0) AS total_pnl,
        COALESCE(AVG(score),0) AS avg_score
      FROM signals
      WHERE timestamp >= datetime('now','-30 days')
        AND outcome IS NOT NULL
      GROUP BY tier
      ORDER BY 
        CASE tier
          WHEN 'KILLER' THEN 1
          WHEN 'STRONG' THEN 2
          WHEN 'MODERATE' THEN 3
          WHEN 'WEAK' THEN 4
          ELSE 5
        END`
    ).all();

    const tiers = (result.results ?? []).map((t) => ({
      ...t,
      win_rate:
        t.wins + t.losses > 0
          ? Math.round((t.wins / (t.wins + t.losses)) * 1000) / 10
          : 0,
    }));

    return json({ tiers });
  } catch (e) {
    return error(e.message, 500);
  }
}

// ─────────────────────────────────────────────────────────
//  GET /api/status
// ─────────────────────────────────────────────────────────
async function handleStatus(env) {
  try {
    const status = await env.DB.prepare(
      "SELECT * FROM system_status WHERE id = 1"
    ).first();
    return json({ status: status ?? {} });
  } catch (e) {
    return error(e.message, 500);
  }
}

// ─────────────────────────────────────────────────────────
//  GET /api/distribution — Outcome distribution
// ─────────────────────────────────────────────────────────
async function handleDistribution(env) {
  try {
    const result = await env.DB.prepare(
      `SELECT 
        COALESCE(outcome,'pending') AS outcome,
        COUNT(*) AS count
      FROM signals
      WHERE timestamp >= datetime('now','-30 days')
      GROUP BY outcome`
    ).all();

    return json({ distribution: result.results ?? [] });
  } catch (e) {
    return error(e.message, 500);
  }
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
    const path = url.pathname;

    try {
      if (path === "/sync" && request.method === "POST") {
        return await handleSync(request, env);
      }

      if (path === "/api/overview") return await handleOverview(env);
      if (path === "/api/signals") return await handleSignals(request, env);
      if (path === "/api/trades") return await handleTrades(request, env);
      if (path === "/api/equity") return await handleEquity(request, env);
      if (path === "/api/tiers") return await handleTiers(env);
      if (path === "/api/status") return await handleStatus(env);
      if (path === "/api/distribution") return await handleDistribution(env);

      if (path === "/" || path === "/health") {
        return json({
          ok: true,
          service: "XAUUSD AI Signal Engine API",
          version: "1.0.0",
          timestamp: new Date().toISOString(),
        });
      }

      return error("Not found", 404);
    } catch (e) {
      console.error("Router error:", e.message);
      return error(`Server error: ${e.message}`, 500);
    }
  },
};
