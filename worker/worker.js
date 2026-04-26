export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("Only POST", { status: 405 });
    }

    try {
      const data = await request.json();

      // =========================
      // FORMAT TELEGRAM
      // =========================
      const message = `
🔥 SIGNAL ${data.type}

📊 Entry: ${data.entry}
🛑 SL: ${data.sl}
🎯 TP: ${data.tp}

⭐ Score: ${data.score}
🧠 Reason: ${data.reason.join(", ")}

⏰ Time: ${new Date(data.timestamp * 1000).toLocaleString()}
      `;

      // =========================
      // SEND TELEGRAM
      // =========================
      await fetch(`https://api.telegram.org/botYOUR_TOKEN/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: "YOUR_CHAT_ID",
          text: message
        })
      });

      // =========================
      // LOG (UNTUK DASHBOARD)
      // =========================
      // nanti bisa upgrade ke KV / D1
      console.log("Signal:", data);

      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" }
      });

    } catch (err) {
      return new Response("Error: " + err.message, { status: 500 });
    }
  }
};
