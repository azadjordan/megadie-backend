// utils/sendTransactionalEmail.js
import { Resend } from "resend";

export default async function sendTransactionalEmail({
  to,
  subject,
  html,
  text,
  replyTo,
}) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY missing — email not sent");
  }

  const from = (process.env.EMAIL_FROM || "").trim();
  if (!from) {
    throw new Error("EMAIL_FROM missing — email not sent");
  }

  const resend = new Resend(apiKey);

  const result = await resend.emails.send({
    from,
    to,
    subject,
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof html === "string" ? { html } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  });

  // Helpful in Render logs for debugging
  console.log("Resend accepted email", { to, id: result?.data?.id ?? result?.id });

  return result;
}