/**
 * XAU Trading Bot Dashboard - Cloudflare Worker v2
 *
 * NEW ENDPOINTS (vs v1):
 *   POST /heartbeat   - liveness ping setiap 60s
 *   POST /event       - bot events (mode change, kill switch, dll)
 *   GET  /heartbeat   - ambil status terakhir
 *   GET  /events      - ambil recent events
 *   GET  /summary     - dashboard summary lengkap dalam 1 call
 *   GET  /trades/open - posisi yang masih open
 *   GET  /modes       - stats per mode
 *
 * IMPROVED:
 *   - Trade close juga update trades.exit & trades.profit (untuk match)
 *   - /closes return dengan join trade info
 *   - /stats include per-mode breakdown
 *
 * REQUIRED D1 SCHEMA (lihat schema.sql):
 *   trades, closes, signals, account, heartbeats, events
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ─── SIGNAL ────────────────────────────────────────────
      if (path === "/signal" && request.method === "POST") {
        const d = await request.json();
        if (!d.type || typeof d.entry !== "number") {
          return json({ error: "invalid signal" }, 400);
        }
        const result = await env.DB.prepare(`
          INSERT INTO signals (type, entry, sl, tp, score, mode, voters, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          d.type, d.entry, d.sl || 0, d.tp || 0,
          d.score || 0, d.mode || "", d.voters || "",
          d.timestamp || Date.now()
        ).run();
        return json({ status: "ok", id: result.meta.last_row_id });
      }

      // ─── ACCOUNT POST ──────────────────────────────────────
      if (path === "/account" && request.method === "POST") {
        const d = await request.json();
        if (typeof d.balance !== "number") {
          return json({ error: "invalid account" }, 400);
        }
        await env.DB.prepare(`
          INSERT INTO account (balance, equity, profit, timestamp)
          VALUES (?, ?, ?, ?)
        `).bind(
          d.balance, d.equity || 0, d.profit || 0, d.timestamp || Date.now()
        ).run();
        return json({ status: "ok" });
      }

      // ─── ACCOUNT GET ───────────────────────────────────────
      if (path === "/account") {
        const data = await env.DB.prepare(`
          SELECT * FROM account ORDER BY id DESC LIMIT 1
        `).first();
        return json(data || {});
      }

      // ─── TRADE OPEN ────────────────────────────────────────
      if (path === "/trade" && request.method === "POST") {
        const d = await request.json();
        if (!d.type || typeof d.entry !== "number") {
          return json({ error: "invalid trade" }, 400);
        }
        const result = await env.DB.prepare(`
          INSERT INTO trades 
            (ticket, type, entry, sl, tp, lot, mode, voters, prob, status, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          d.ticket || null, d.type, d.entry, d.sl || 0, d.tp || 0,
          d.lot || 0.01, d.mode || "", d.voters || "",
          d.prob || 0, "open", d.time || Date.now()
        ).run();
        return json({ status: "ok", trade_id: result.meta.last_row_id });
      }

      // ─── CLOSE TRADE ───────────────────────────────────────
      if (path === "/close" && request.method === "POST") {
        const d = await request.json();
        if (typeof d.profit !== "number") {
          return json({ error: "invalid profit" }, 400);
        }

        // Dedup check: kalau trade_id sudah ada di closes dalam 5 menit terakhir,
        // skip insert (avoid duplicate close records dari restart bot)
        if (d.trade_id) {
          const recentCutoff = (d.time || Date.now()) - 5 * 60 * 1000;
          const dup = await env.DB.prepare(`
            SELECT id FROM closes 
            WHERE trade_id = ? AND timestamp > ? 
            LIMIT 1
          `).bind(d.trade_id, recentCutoff).first();
          if (dup) {
            return json({ status: "ok", duplicate: true });
          }
        }

        // Insert close record
        await env.DB.prepare(`
          INSERT INTO closes (trade_id, ticket, exit_price, profit, reason, session, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          d.trade_id || null, d.trade_id || null, d.exit || 0,
          d.profit, d.reason || "", d.session || "UNKNOWN",
          d.time || Date.now()
        ).run();

        // Update trades.status & exit info kalau ticket match
        if (d.trade_id) {
          await env.DB.prepare(`
            UPDATE trades 
            SET status = 'closed', exit_price = ?, profit = ?, close_reason = ?, close_time = ?
            WHERE ticket = ?
          `).bind(
            d.exit || 0, d.profit, d.reason || "", d.time || Date.now(),
            d.trade_id
          ).run();
        }

        return json({ status: "ok" });
      }

      // ─── HEARTBEAT POST ────────────────────────────────────
      if (path === "/heartbeat" && request.method === "POST") {
        const d = await request.json();
        await env.DB.prepare(`
          INSERT INTO heartbeats (status, mode, wins, losses, consecutive_losses, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          d.status || "running",
          d.mode || "",
          d.wins || 0,
          d.losses || 0,
          d.consecutive_losses || 0,
          d.timestamp || Date.now()
        ).run();
        return json({ status: "ok" });
      }

      // ─── HEARTBEAT GET ─────────────────────────────────────
      if (path === "/heartbeat") {
        const data = await env.DB.prepare(`
          SELECT * FROM heartbeats ORDER BY id DESC LIMIT 1
        `).first();
        // Detect stale (> 3 minutes = bot mungkin offline)
        if (data) {
          const age_sec = (Date.now() - data.timestamp) / 1000;
          data.age_seconds = Math.round(age_sec);
          data.is_alive = age_sec < 180;
        }
        return json(data || { is_alive: false, status: "offline" });
      }

      // ─── EVENT ─────────────────────────────────────────────
      if (path === "/event" && request.method === "POST") {
        const d = await request.json();
        await env.DB.prepare(`
          INSERT INTO events (type, message, data, timestamp)
          VALUES (?, ?, ?, ?)
        `).bind(
          d.type || "info",
          d.message || "",
          JSON.stringify(d.data || {}),
          d.timestamp || Date.now()
        ).run();
        return json({ status: "ok" });
      }

      if (path === "/events") {
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const data = await env.DB.prepare(`
          SELECT * FROM events ORDER BY id DESC LIMIT ?
        `).bind(limit).all();
        const results = (data.results || []).map(r => ({
          ...r,
          data: r.data ? JSON.parse(r.data) : {},
        }));
        return json(results);
      }

      // ─── LOG STREAMING ─────────────────────────────────────
      // Receive log lines from bot for live monitoring
      if (path === "/log" && request.method === "POST") {
        const d = await request.json();
        await env.DB.prepare(`
          INSERT INTO logs (level, logger, message, timestamp)
          VALUES (?, ?, ?, ?)
        `).bind(
          d.level || "INFO",
          d.logger || "",
          (d.message || "").substring(0, 1000),  // safety truncate
          d.timestamp || Date.now()
        ).run();
        return json({ status: "ok" });
      }

      // GET logs (with optional level filter)
      if (path === "/logs") {
        const limit = parseInt(url.searchParams.get("limit") || "200");
        const level = url.searchParams.get("level");  // optional filter
        let query = `SELECT * FROM logs`;
        const args = [];
        if (level) {
          query += ` WHERE level = ?`;
          args.push(level);
        }
        query += ` ORDER BY id DESC LIMIT ?`;
        args.push(limit);
        const data = await env.DB.prepare(query).bind(...args).all();
        return json(data.results || []);
      }

      // Cleanup old logs (called manually atau oleh cron worker terpisah)
      if (path === "/logs/cleanup" && request.method === "POST") {
        const cutoff = Date.now() - (24 * 60 * 60 * 1000);  // 24h ago
        const result = await env.DB.prepare(`
          DELETE FROM logs WHERE timestamp < ?
        `).bind(cutoff).run();
        return json({ status: "ok", deleted: result.meta.changes });
      }

      // ─── CLOSES (existing - improved) ─────────────────────
      if (path === "/closes") {
        const limit = parseInt(url.searchParams.get("limit") || "200");
        const data = await env.DB.prepare(`
          SELECT 
            id, trade_id, ticket, exit_price, profit, reason, session,
            timestamp as time
          FROM closes
          ORDER BY id DESC
          LIMIT ?
        `).bind(limit).all();
        return json(data.results || []);
      }

      // ─── TRADES (all) ──────────────────────────────────────
      if (path === "/trades") {
        const limit = parseInt(url.searchParams.get("limit") || "100");
        const data = await env.DB.prepare(`
          SELECT * FROM trades ORDER BY id DESC LIMIT ?
        `).bind(limit).all();
        return json(data.results || []);
      }

      // ─── TRADES OPEN (currently active) ────────────────────
      // Exclude trades yang sebenarnya sudah di-close (ada di closes table)
      // Ini fix untuk "stuck position" yang tidak update status='closed'
      if (path === "/trades/open") {
        const data = await env.DB.prepare(`
          SELECT * FROM trades 
          WHERE status = 'open' 
          AND ticket NOT IN (
            SELECT trade_id FROM closes WHERE trade_id IS NOT NULL
          )
          ORDER BY timestamp DESC
        `).all();
        return json(data.results || []);
      }

      // ─── ADMIN: RECONCILE (fix stuck open trades) ──────────
      // Auto-mark trades sebagai 'closed' kalau ada close record
      if (path === "/admin/reconcile" && request.method === "POST") {
        const result = await env.DB.prepare(`
          UPDATE trades 
          SET status = 'closed' 
          WHERE status = 'open' 
          AND ticket IN (SELECT trade_id FROM closes WHERE trade_id IS NOT NULL)
        `).run();
        return json({ status: "ok", reconciled: result.meta.changes });
      }

      // ─── ADMIN: FORCE CLOSE STUCK (cleanup tanpa close record) ─
      // Mark semua open trade > 24h sebagai closed (orphaned)
      if (path === "/admin/cleanup_stuck" && request.method === "POST") {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const result = await env.DB.prepare(`
          UPDATE trades 
          SET status = 'closed', close_reason = 'orphaned_cleanup', close_time = ?
          WHERE status = 'open' AND timestamp < ?
        `).bind(Date.now(), cutoff).run();
        return json({ status: "ok", cleaned: result.meta.changes });
      }

      // ─── MODES (per-mode stats) ────────────────────────────
      if (path === "/modes") {
        const data = await env.DB.prepare(`
          SELECT 
            mode,
            COUNT(*) as total,
            SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN profit <= 0 THEN 1 ELSE 0 END) as losses,
            SUM(profit) as total_profit,
            AVG(profit) as avg_profit
          FROM trades
          WHERE status = 'closed' AND mode != ''
          GROUP BY mode
        `).all();
        return json(data.results || []);
      }

      // ─── STATS (improved with per-mode) ────────────────────
      if (path === "/stats") {
        const total = await env.DB.prepare(
          `SELECT COUNT(*) as total FROM trades`
        ).first();
        const win = await env.DB.prepare(
          `SELECT COUNT(*) as win FROM closes WHERE profit > 0`
        ).first();
        const loss = await env.DB.prepare(
          `SELECT COUNT(*) as loss FROM closes WHERE profit <= 0`
        ).first();
        const profit = await env.DB.prepare(
          `SELECT SUM(profit) as total_profit FROM closes`
        ).first();

        return json({
          total: total?.total || 0,
          win: win?.win || 0,
          loss: loss?.loss || 0,
          profit: profit?.total_profit || 0,
        });
      }

      // ─── SUMMARY (everything in one call) ──────────────────
      if (path === "/summary") {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayMs = todayStart.getTime();

        // Heartbeat
        const hb = await env.DB.prepare(
          `SELECT * FROM heartbeats ORDER BY id DESC LIMIT 1`
        ).first();
        const hb_age = hb ? (Date.now() - hb.timestamp) / 1000 : 999;

        // Account
        const account = await env.DB.prepare(
          `SELECT * FROM account ORDER BY id DESC LIMIT 1`
        ).first();

        // Today's stats
        const today = await env.DB.prepare(`
          SELECT
            COUNT(*) as trades,
            SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN profit <= 0 THEN 1 ELSE 0 END) as losses,
            SUM(profit) as profit
          FROM closes WHERE timestamp >= ?
        `).bind(todayMs).first();

        // All-time stats
        const all = await env.DB.prepare(`
          SELECT
            COUNT(*) as trades,
            SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN profit <= 0 THEN 1 ELSE 0 END) as losses,
            SUM(profit) as profit
          FROM closes
        `).first();

        // Open positions
        const openPos = await env.DB.prepare(`
          SELECT COUNT(*) as count FROM trades WHERE status = 'open'
        `).first();

        // Per-mode
        const modes = await env.DB.prepare(`
          SELECT mode, COUNT(*) as total,
                 SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as wins,
                 SUM(profit) as profit
          FROM trades WHERE status = 'closed' AND mode != ''
          GROUP BY mode
        `).all();

        // Recent events
        const events = await env.DB.prepare(`
          SELECT * FROM events ORDER BY id DESC LIMIT 5
        `).all();

        return json({
          status: {
            is_alive: hb_age < 180,
            status: hb?.status || "offline",
            mode: hb?.mode || "",
            age_seconds: Math.round(hb_age),
            consecutive_losses: hb?.consecutive_losses || 0,
          },
          account: account || {},
          today: {
            trades: today?.trades || 0,
            wins: today?.wins || 0,
            losses: today?.losses || 0,
            profit: today?.profit || 0,
          },
          all_time: {
            trades: all?.trades || 0,
            wins: all?.wins || 0,
            losses: all?.losses || 0,
            profit: all?.profit || 0,
          },
          open_positions: openPos?.count || 0,
          modes: modes.results || [],
          recent_events: (events.results || []).map(e => ({
            ...e,
            data: e.data ? JSON.parse(e.data) : {},
          })),
        });
      }

      // ─── HEALTH CHECK ──────────────────────────────────────
      if (path === "/health") {
        return json({ status: "ok", time: Date.now() });
      }

      return json({ error: "Not found", path }, 404);
    } catch (e) {
      return json({ error: e.message, stack: e.stack }, 500);
    }
  },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(),
  });
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

