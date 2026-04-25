export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // Endpoint test
    if (url.pathname === "/test") {
      await sendTelegram(env, "🚀 Bot aktif! Siap kirim signal XAUUSD")
      return new Response("TEST OK")
    }

    // Endpoint signal (manual trigger)
    if (url.pathname === "/signal") {
      const signal = {
        type: "BUY",
        entry: 2330,
        sl: 2320,
        tp: 2350
      }

      const text = formatSignal(signal)

      await sendTelegram(env, text)

      return new Response("SIGNAL SENT")
    }

    return new Response("Worker running...")
  }
}

// =======================
// FORMAT SIGNAL
// =======================
function formatSignal(s) {
  return `
📊 XAUUSD SIGNAL

🟢 ${s.type}
Entry : ${s.entry}
SL    : ${s.sl}
TP    : ${s.tp}

⚠️ Risk 1-2%
`
}

// =======================
// TELEGRAM FUNCTION
// =======================
async function sendTelegram(env, text) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: env.CHAT_ID,
      text: text
    })
  })
}
