export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // =========================
    // SIGNAL
    // =========================
    if (url.pathname === "/signal" && request.method === "POST") {
      try {
        const d = await request.json();

        if (!d.type || typeof d.entry !== "number") {
          return json({ error: "invalid signal" }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO signals (type, entry, sl, tp, score, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          d.type,
          d.entry,
          d.sl || 0,
          d.tp || 0,
          d.score || 0,
          d.timestamp || Date.now()
        ).run();

        return json({ status: "ok", id: result.meta.last_row_id });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // =========================
    // ACCOUNT (POST)
    // =========================
    if (url.pathname === "/account" && request.method === "POST") {
      try {
        const d = await request.json();

        if (typeof d.balance !== "number") {
          return json({ error: "invalid account" }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO account (balance, equity, profit, timestamp)
          VALUES (?, ?, ?, ?)
        `).bind(
          d.balance,
          d.equity || 0,
          d.profit || 0,
          d.timestamp || Date.now()
        ).run();

        return json({ status: "ok" });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // =========================
    // ACCOUNT (GET)
    // =========================
    if (url.pathname === "/account") {
      const data = await env.DB.prepare(`
        SELECT * FROM account ORDER BY id DESC LIMIT 1
      `).first();

      return json(data || {});
    }

    // =========================
    // TRADE OPEN
    // =========================
    if (url.pathname === "/trade" && request.method === "POST") {
      try {
        const d = await request.json();

        if (!d.type || typeof d.entry !== "number") {
          return json({ error: "invalid trade" }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO trades (type, entry, sl, tp, prob, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          d.type,
          d.entry,
          d.sl || 0,
          d.tp || 0,
          d.prob || 0,
          d.time || Date.now()
        ).run();

        return json({
          status: "ok",
          trade_id: result.meta.last_row_id
        });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // =========================
    // CLOSE TRADE (FIXED)
    // =========================
    if (url.pathname === "/close" && request.method === "POST") {
      try {
        const d = await request.json();

        if (typeof d.profit !== "number") {
          return json({ error: "invalid profit" }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO closes (trade_id, profit, session, timestamp)
          VALUES (?, ?, ?, ?)
        `).bind(
          d.trade_id || null,
          d.profit,
          d.session || "UNKNOWN",
          d.time || Date.now()
        ).run();

        return json({ status: "ok" });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // =========================
    // GET CLOSES (DASHBOARD)
    // =========================
    if (url.pathname === "/closes") {
      const data = await env.DB.prepare(`
        SELECT 
          profit,
          timestamp as time,
          session
        FROM closes
        ORDER BY id DESC
        LIMIT 200
      `).all();

      return json(data.results || []);
    }

    // =========================
    // GET TRADES
    // =========================
    if (url.pathname === "/trades") {
      const data = await env.DB.prepare(`
        SELECT * FROM trades ORDER BY id DESC LIMIT 100
      `).all();

      return json(data.results || []);
    }

    // =========================
    // STATS (IMPROVED)
    // =========================
    if (url.pathname === "/stats") {

      const total = await env.DB.prepare(`
        SELECT COUNT(*) as total FROM trades
      `).first();

      const win = await env.DB.prepare(`
        SELECT COUNT(*) as win FROM closes WHERE profit > 0
      `).first();

      const loss = await env.DB.prepare(`
        SELECT COUNT(*) as loss FROM closes WHERE profit <= 0
      `).first();

      const profit = await env.DB.prepare(`
        SELECT SUM(profit) as total_profit FROM closes
      `).first();

      return json({
        total: total.total || 0,
        win: win.win || 0,
        loss: loss.loss || 0,
        profit: profit.total_profit || 0
      });
    }

    // =========================
    // HEALTH CHECK
    // =========================
    if (url.pathname === "/health") {
      return json({ status: "ok", time: Date.now() });
    }

    return json({ error: "Not found" }, 404);
  }
};

// =========================
// HELPERS
// =========================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders()
  });
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
