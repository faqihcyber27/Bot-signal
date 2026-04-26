export default {
  async fetch(request, env) {

    // =========================
    // CORS PREFLIGHT
    // =========================
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    const url = new URL(request.url);

    // =========================
    // POST SIGNAL
    // =========================
    if (url.pathname === "/signal" && request.method === "POST") {
      try {
        const data = await request.json();

        // VALIDASI BASIC
        if (!data.type || !data.entry || !data.sl || !data.tp) {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers: corsHeaders()
          });
        }

        // INSERT DB + AMBIL ID
        const result = await env.DB.prepare(`
          INSERT INTO signals (type, entry, sl, tp, score, reason, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          data.type,
          data.entry,
          data.sl,
          data.tp,
          data.score,
          JSON.stringify(data.reason),
          data.timestamp
        ).run();

        const insertedId = result.meta.last_row_id;

        // TELEGRAM MESSAGE
        const msg = `
🔥 ${data.type} XAUUSD

Entry: ${data.entry}
SL: ${data.sl}
TP: ${data.tp}

Score: ${data.score}
Reason: ${data.reason.join(", ")}
        `;

        await fetch(`https://api.telegram.org/botYOUR_TOKEN/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: "YOUR_CHAT_ID",
            text: msg
          })
        });

        return new Response(JSON.stringify({
          status: "ok",
          id: insertedId
        }), {
          headers: corsHeaders()
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: corsHeaders()
        });
      }
    }

    // =========================
    // UPDATE RESULT (WIN / LOSS)
    // =========================
    if (url.pathname === "/update-result" && request.method === "POST") {
      try {
        const { id, result } = await request.json();

        if (!id || !result) {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers: corsHeaders()
          });
        }

        await env.DB.prepare(`
          UPDATE signals SET result = ? WHERE id = ?
        `).bind(result, id).run();

        return new Response(JSON.stringify({ status: "updated" }), {
          headers: corsHeaders()
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: corsHeaders()
        });
      }
    }

    // =========================
    // GET SIGNALS
    // =========================
    if (url.pathname === "/signals") {
      const data = await env.DB.prepare(`
        SELECT * FROM signals ORDER BY id DESC LIMIT 100
      `).all();

      return new Response(JSON.stringify(data.results), {
        headers: corsHeaders()
      });
    }

    // =========================
    // GET STATS (REAL)
    // =========================
    if (url.pathname === "/stats") {
      const total = await env.DB.prepare(`
        SELECT COUNT(*) as total FROM signals
      `).first();

      const buy = await env.DB.prepare(`
        SELECT COUNT(*) as buy FROM signals WHERE type='BUY'
      `).first();

      const sell = await env.DB.prepare(`
        SELECT COUNT(*) as sell FROM signals WHERE type='SELL'
      `).first();

      const win = await env.DB.prepare(`
        SELECT COUNT(*) as win FROM signals WHERE result='WIN'
      `).first();

      const loss = await env.DB.prepare(`
        SELECT COUNT(*) as loss FROM signals WHERE result='LOSS'
      `).first();

      return new Response(JSON.stringify({
        total: total.total,
        buy: buy.buy,
        sell: sell.sell,
        win: win.win,
        loss: loss.loss
      }), {
        headers: corsHeaders()
      });
    }

    // =========================
    // DEFAULT
    // =========================
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: corsHeaders()
    });
  }
};

// =========================
// CORS HELPER
// =========================
function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
