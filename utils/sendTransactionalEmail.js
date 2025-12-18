// utils/sendTransactionalEmail.js
import { Resend } from "resend";

/**
 * Startup-friendly:
 * - doesn't crash server if RESEND_API_KEY is missing
 * - instantiates Resend only when sending
 */
export default async function sendTransactionalEmail({
  to,
  subject,
  html,
  text,
  replyTo, // optional
}) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    console.warn("⚠️ RESEND_API_KEY missing — email not sent");
    return;
  }

  const from = (process.env.EMAIL_FROM || "Megadie <onboarding@resend.dev>").trim();

  const resend = new Resend(apiKey);

  await resend.emails.send({
    from,
    to,
    subject,
    // only include fields if provided
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof html === "string" ? { html } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  });
}
