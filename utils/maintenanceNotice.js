export const MAINTENANCE_MESSAGE = "We’re carrying out temporary maintenance. Please contact us to confirm stock availability during this time.";
export const MAINTENANCE_MESSAGE_MAX_LENGTH = 500;

export function normalizeNoticeMessage(value) {
  if (typeof value !== "string") throw new Error("Notice message must be text.");
  const message = value.replace(/\s+/gu, " ").trim();
  if (!message) throw new Error("Enter a notice message.");
  if (message.length > MAINTENANCE_MESSAGE_MAX_LENGTH) throw new Error(`Notice message must be ${MAINTENANCE_MESSAGE_MAX_LENGTH} characters or fewer.`);
  return message;
}
