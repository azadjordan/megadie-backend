// Read configuration when sending: server.js loads the environment at startup.
const sendTelegramAlert = async (message, { plainText = false, strict = false } = {}) => {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    if (strict) throw new Error("Telegram is not configured.");
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        ...(plainText ? {} : { parse_mode: "Markdown" }),
      }),
    });

    if (!res.ok) {
      throw new Error(`Telegram request failed (${res.status}).`);
    }
    const result = await res.json();
    if (!result.ok) throw new Error("Telegram did not accept the message.");
    return true;
  } catch (error) {
    // Never log fetch errors containing a URL with the bot token.
    const safe = new Error(error.name === "TimeoutError" ? "Telegram request timed out." : "Telegram delivery failed.");
    if (strict) throw safe;
    console.error("❌ Telegram alert failed:", safe.message);
    return false;
  }
};

export default sendTelegramAlert;
