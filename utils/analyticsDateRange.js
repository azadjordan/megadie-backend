const DAY_MS = 24 * 60 * 60 * 1000;

export const ANALYTICS_TIME_ZONE = "Asia/Dubai";
export const ANALYTICS_MONGO_TIME_ZONE = "+04:00";
export const ANALYTICS_UTC_OFFSET_MINUTES = 4 * 60;

const OFFSET_MS = ANALYTICS_UTC_OFFSET_MINUTES * 60 * 1000;

// Admin analytics treats YYYY-MM-DD inputs as Dubai business calendar dates.
// MongoDB filters use an inclusive UTC start and exclusive UTC end.

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeDateKey(value, label) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${label} must be in YYYY-MM-DD format.`);
  }

  const [year, month, day] = raw.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be a valid calendar date.`);
  }

  return {
    key: raw,
    year,
    month,
    day,
    utcDayMs: Date.UTC(year, month - 1, day),
  };
}

function formatDateKeyFromUtcDayMs(utcDayMs) {
  const date = new Date(utcDayMs);
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
  ].join("-");
}

function getBusinessTodayDateKey(now = new Date()) {
  return formatDateKeyFromUtcDayMs(now.getTime() + OFFSET_MS);
}

function addDays(dateKey, days) {
  const parsed = normalizeDateKey(dateKey, "date");
  return formatDateKeyFromUtcDayMs(parsed.utcDayMs + days * DAY_MS);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isFullCalendarMonth(from, to) {
  return (
    from.day === 1 &&
    from.year === to.year &&
    from.month === to.month &&
    to.day === daysInMonth(to.year, to.month)
  );
}

function previousCalendarMonth(from) {
  const previousMonth = from.month === 1 ? 12 : from.month - 1;
  const previousYear = from.month === 1 ? from.year - 1 : from.year;

  return {
    from: `${previousYear}-${pad2(previousMonth)}-01`,
    to: `${previousYear}-${pad2(previousMonth)}-${pad2(
      daysInMonth(previousYear, previousMonth)
    )}`,
  };
}

function businessDateStartToUtc(dateKey) {
  const parsed = normalizeDateKey(dateKey, "date");
  return new Date(parsed.utcDayMs - OFFSET_MS);
}

export function enumerateDateKeys(fromKey, toKey) {
  const from = normalizeDateKey(fromKey, "from");
  const to = normalizeDateKey(toKey, "to");
  const dates = [];

  for (let time = from.utcDayMs; time <= to.utcDayMs; time += DAY_MS) {
    dates.push(formatDateKeyFromUtcDayMs(time));
  }

  return dates;
}

export function buildAnalyticsDateRange(query = {}, now = new Date()) {
  const businessToday = getBusinessTodayDateKey(now);
  const todayParts = normalizeDateKey(businessToday, "today");
  const defaultFrom = `${todayParts.year}-${pad2(todayParts.month)}-01`;

  const fromKey = query.from ? String(query.from).trim() : defaultFrom;
  const toKey = query.to ? String(query.to).trim() : businessToday;
  const from = normalizeDateKey(fromKey, "from");
  const to = normalizeDateKey(toKey, "to");

  if (from.utcDayMs > to.utcDayMs) {
    throw new Error("from must be before or equal to to.");
  }

  const dayCount = Math.round((to.utcDayMs - from.utcDayMs) / DAY_MS) + 1;
  const previous = isFullCalendarMonth(from, to)
    ? previousCalendarMonth(from)
    : {
        to: addDays(from.key, -1),
        from: addDays(from.key, -dayCount),
      };

  const nextToKey = addDays(to.key, 1);
  const nextPreviousToKey = addDays(previous.to, 1);

  return {
    from: from.key,
    to: to.key,
    previousFrom: previous.from,
    previousTo: previous.to,
    start: businessDateStartToUtc(from.key),
    endExclusive: businessDateStartToUtc(nextToKey),
    previousStart: businessDateStartToUtc(previous.from),
    previousEndExclusive: businessDateStartToUtc(nextPreviousToKey),
    dayCount,
    timezone: ANALYTICS_TIME_ZONE,
    mongoTimezone: ANALYTICS_MONGO_TIME_ZONE,
    boundary: "inclusive start, exclusive end",
  };
}
