import { logger } from "./logger.js";

// Fire-and-forget Telegram alerts. No signer/config imports — safe from
// both the bot process and the admin process. No-ops quietly if unset, so
// it's optional infrastructure, not a hard requirement.

let warnedOnce = false;

export async function sendAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    if (!warnedOnce) {
      logger.warn("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — alerts are disabled");
      warnedOnce = true;
    }
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!res.ok) logger.warn(`Telegram alert failed: HTTP ${res.status}`, await res.text().catch(() => ""));
  } catch (err) {
    logger.warn("Telegram alert failed", err instanceof Error ? err.message : err);
  }
}
