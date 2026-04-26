export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================
    // POST SIGNAL
    // =========================
    if (url.pathname === "/signal" && request.method === "POST") {
      try {
        const data = await request.json();

        // SAVE KE DB
        await env.DB.prepare(`
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

        // TELEGRAM
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

        return new Response("OK");

      } catch (e) {
        return new Response("Error: " + e.message, { status: 500 });
      }
    }

    // =========================
    // GET SIGNALS (DASHBOARD)
    // =========================
    if (url.pathname === "/signals") {
      const data = await env.DB.prepare(`
        SELECT * FROM signals ORDER BY id DESC LIMIT 100
      `).all();

      return new Response(JSON.stringify(data.results), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // =========================
    // GET STATS
    // =========================
    if (url.pathname === "/stats") {
      const total = await env.DB.prepare(`SELECT COUNT(*) as total FROM signals`).first();
      const buy = await env.DB.prepare(`SELECT COUNT(*) as buy FROM signals WHERE type='BUY'`).first();
      const sell = await env.DB.prepare(`SELECT COUNT(*) as sell FROM signals WHERE type='SELL'`).first();

      return new Response(JSON.stringify({
        total: total.total,
        buy: buy.buy,
        sell: sell.sell
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};

headers: {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
}
