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
        const data = await request.json();

        if (!data.type || !data.entry) {
          return json({ error: "invalid" }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO signals (type, entry, sl, tp, score, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          data.type,
          data.entry,
          data.sl,
          data.tp,
          data.score || 0,
          data.timestamp || Date.now()
        ).run();

        return json({ status: "ok", id: result.meta.last_row_id });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // =========================
    // 🔥 ACCOUNT (INI YANG LO BUTUH)
    // =========================
    if (url.pathname === "/account" && request.method === "POST") {
      try {
        const data = await request.json();

        await env.DB.prepare(`
          INSERT INTO account (balance, equity, profit, timestamp)
          VALUES (?, ?, ?, ?)
        `).bind(
          data.balance,
          data.equity,
          data.profit,
          data.timestamp
        ).run();

        return json({ status: "ok" });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // =========================
    // 🔥 TRADE LOG
    // =========================
    if (url.pathname === "/trade" && request.method === "POST") {
      try {
        const d = await request.json();

        await env.DB.prepare(`
          INSERT INTO trades (type, entry, sl, tp, prob, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          d.type,
          d.entry,
          d.sl,
          d.tp,
          d.prob,
          d.time
        ).run();

        return json({ status: "ok" });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // =========================
    // 🔥 CLOSE LOG
    // =========================
    if (url.pathname === "/close" && request.method === "POST") {
      try {
        const d = await request.json();

        await env.DB.prepare(`
          INSERT INTO closes (profit, timestamp)
          VALUES (?, ?)
        `).bind(
          d.profit,
          Date.now()
        ).run();

        return json({ status: "ok" });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // =========================
    // GET ACCOUNT (UNTUK DASHBOARD)
    // =========================
    if (url.pathname === "/account") {
      const data = await env.DB.prepare(`
        SELECT * FROM account ORDER BY id DESC LIMIT 1
      `).first();

      return json(data || {});
    }

    // =========================
    // GET TRADES
    // =========================
    if (url.pathname === "/trades") {
      const data = await env.DB.prepare(`
        SELECT * FROM trades ORDER BY id DESC LIMIT 50
      `).all();

      return json(data.results);
    }

    // =========================
    // STATS
    // =========================
    if (url.pathname === "/stats") {
      const total = await env.DB.prepare(`SELECT COUNT(*) as total FROM trades`).first();
      const win = await env.DB.prepare(`SELECT COUNT(*) as win FROM closes WHERE profit > 0`).first();
      const loss = await env.DB.prepare(`SELECT COUNT(*) as loss FROM closes WHERE profit <= 0`).first();

      return json({
        total: total.total,
        win: win.win,
        loss: loss.loss
      });
    }

    return json({ error: "Not found" }, 404);
  }
};

// =========================
// HELPER
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
