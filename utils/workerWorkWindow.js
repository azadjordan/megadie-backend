const DAY = 86400000;
const DUBAI = 4 * 3600000;
export const dubaiDayStart = (now = new Date()) => new Date(Math.floor((+new Date(now) + DUBAI) / DAY) * DAY - DUBAI);
export const workerWorkExpiresAt = completedAt => new Date(+dubaiDayStart(completedAt) + 3 * DAY);
export const dubaiMonthStart = (now = new Date()) => new Date(new Date(+new Date(now) + DUBAI).toISOString().slice(0, 7) + '-01T00:00:00+04:00');

export function workWindow(period = 'today', now = new Date()) {
  const today = +dubaiDayStart(now);
  if (period === 'today') return { start: new Date(today), end: new Date(+now + 1) };
  if (period === 'yesterday') return { start: new Date(today - DAY), end: new Date(today) };
  if (period === 'dayBeforeYesterday') return { start: new Date(today - 2 * DAY), end: new Date(today - DAY) };
  if (period === 'last3') return { start: new Date(today - 2 * DAY), end: new Date(+now + 1) };
  if (period === 'last7') return { start: new Date(today - 6 * DAY), end: new Date(+now + 1) };
  return null;
}
