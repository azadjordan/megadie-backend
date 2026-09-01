import net from "net";

const STRING_LIMITS = {
  userAgent: 500,
  ipSource: 80,
  ipCountry: 2,
  referrer: 500,
  origin: 250,
  acceptLanguage: 250,
  browserLanguage: 100,
  timezone: 100,
  landingPath: 300,
  emailDomain: 200,
  utm: 150,
  browserName: 50,
  osName: 50,
  deviceType: 50,
};

function trimTo(value, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return text.slice(0, maxLength);
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeIp(value) {
  const raw = trimTo(firstHeaderValue(value), 100);
  if (!raw) return undefined;

  const first = raw.split(",")[0]?.trim();
  if (!first) return undefined;

  const withoutMappedPrefix = first.startsWith("::ffff:")
    ? first.slice("::ffff:".length)
    : first;
  const withoutBrackets = withoutMappedPrefix
    .replace(/^\[/, "")
    .replace(/\]$/, "");

  if (net.isIP(withoutBrackets)) return withoutBrackets;

  const ipv4WithPort = withoutBrackets.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort && net.isIP(ipv4WithPort[1])) return ipv4WithPort[1];

  return undefined;
}

function numberInRange(value, { min = 0, max = 100000 } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) return undefined;
  return Math.round(num);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getHeader(req, name) {
  return firstHeaderValue(req?.headers?.[name]);
}

function getCountryCode(req) {
  const country = trimTo(getHeader(req, "cf-ipcountry"), STRING_LIMITS.ipCountry);
  return country?.toUpperCase();
}

function sanitizeUtm(rawUtm) {
  if (!isPlainObject(rawUtm)) return undefined;

  const utm = {
    source: trimTo(rawUtm.source, STRING_LIMITS.utm),
    medium: trimTo(rawUtm.medium, STRING_LIMITS.utm),
    campaign: trimTo(rawUtm.campaign, STRING_LIMITS.utm),
    term: trimTo(rawUtm.term, STRING_LIMITS.utm),
    content: trimTo(rawUtm.content, STRING_LIMITS.utm),
  };

  return Object.values(utm).some((value) => value !== undefined)
    ? utm
    : undefined;
}

function parseUserAgent(userAgent) {
  const raw = String(userAgent || "");
  const ua = raw.toLowerCase();
  if (!ua) {
    return {
      browserName: "Unknown",
      osName: "Unknown",
      deviceType: "Unknown",
    };
  }

  let browserName = "Unknown";
  if (/edg(?:e|a|ios)?\//.test(ua)) {
    browserName = "Edge";
  } else if (/firefox\/|fxios\//.test(ua)) {
    browserName = "Firefox";
  } else if (/crios\/|chrome\//.test(ua)) {
    browserName = "Chrome";
  } else if (/safari\//.test(ua)) {
    browserName = "Safari";
  }

  let osName = "Unknown";
  if (/iphone|ipad|ipod/.test(ua)) {
    osName = "iOS";
  } else if (/android/.test(ua)) {
    osName = "Android";
  } else if (/windows nt/.test(ua)) {
    osName = "Windows";
  } else if (/mac os x|macintosh/.test(ua)) {
    osName = "macOS";
  } else if (/linux/.test(ua)) {
    osName = "Linux";
  }

  let deviceType = "Desktop";
  if (/ipad|tablet|playbook|silk/.test(ua)) {
    deviceType = "Tablet";
  } else if (/mobile|iphone|ipod|android|windows phone/.test(ua)) {
    deviceType = "Mobile";
  }

  return { browserName, osName, deviceType };
}

export function getRequestIp(req) {
  return getRequestIpInfo(req).ip;
}

export function getRequestIpInfo(req) {
  const sources = [
    ["Cloudflare CF-Connecting-IP", getHeader(req, "cf-connecting-ip")],
    ["True-Client-IP", getHeader(req, "true-client-ip")],
    ["X-Real-IP", getHeader(req, "x-real-ip")],
    ["Express req.ip", req?.ip],
    ["Socket remote address", req?.socket?.remoteAddress],
  ];

  for (const [source, rawValue] of sources) {
    const ip = normalizeIp(rawValue);
    if (ip) return { ip, source };
  }

  return { ip: undefined, source: undefined };
}

export function getEmailDomain(email) {
  const value = trimTo(email, 320);
  if (!value || !value.includes("@")) return undefined;
  const domain = value.split("@").pop()?.toLowerCase();
  return trimTo(domain, STRING_LIMITS.emailDomain);
}

export function sanitizeClientAudit(rawClientAudit) {
  if (!isPlainObject(rawClientAudit)) return {};

  return {
    browserLanguage: trimTo(
      rawClientAudit.browserLanguage,
      STRING_LIMITS.browserLanguage
    ),
    timezone: trimTo(rawClientAudit.timezone, STRING_LIMITS.timezone),
    screenWidth: numberInRange(rawClientAudit.screenWidth),
    screenHeight: numberInRange(rawClientAudit.screenHeight),
    viewportWidth: numberInRange(rawClientAudit.viewportWidth),
    viewportHeight: numberInRange(rawClientAudit.viewportHeight),
    signupDurationMs: numberInRange(rawClientAudit.signupDurationMs, {
      min: 0,
      max: 24 * 60 * 60 * 1000,
    }),
    landingPath: trimTo(rawClientAudit.landingPath, STRING_LIMITS.landingPath),
    utm: sanitizeUtm(rawClientAudit.utm),
  };
}

export function buildBrowserContextFilter(audit = {}) {
  const userAgent = trimTo(audit.userAgent, STRING_LIMITS.userAgent);
  const timezone = trimTo(audit.timezone, STRING_LIMITS.timezone);
  const browserLanguage = trimTo(
    audit.browserLanguage,
    STRING_LIMITS.browserLanguage
  );
  const screenWidth = numberInRange(audit.screenWidth);
  const screenHeight = numberInRange(audit.screenHeight);

  if (!userAgent || !timezone || !browserLanguage || !screenWidth || !screenHeight) {
    return null;
  }

  return {
    "registrationAudit.userAgent": userAgent,
    "registrationAudit.timezone": timezone,
    "registrationAudit.browserLanguage": browserLanguage,
    "registrationAudit.screenWidth": screenWidth,
    "registrationAudit.screenHeight": screenHeight,
  };
}

export function buildRegistrationAudit({
  req,
  email,
  ip = getRequestIp(req),
  ipSource,
  sameIpSignupCount = 0,
  sameEmailDomainCount = 0,
  sameBrowserContextSignupCount = 0,
} = {}) {
  const clientAudit = sanitizeClientAudit(req?.body?.clientAudit);
  const sameIpSignupCountAtRegistration = numberInRange(sameIpSignupCount, {
    min: 0,
    max: 1000000,
  }) ?? 0;
  const sameEmailDomainCountAtRegistration = numberInRange(
    sameEmailDomainCount,
    {
      min: 0,
      max: 1000000,
    }
  ) ?? 0;
  const sameBrowserContextSignupCountAtRegistration = numberInRange(
    sameBrowserContextSignupCount,
    {
      min: 0,
      max: 1000000,
    }
  ) ?? 0;
  const userAgent = trimTo(getHeader(req, "user-agent"), STRING_LIMITS.userAgent);
  const userAgentSummary = parseUserAgent(userAgent);

  const audit = {
    capturedAt: new Date(),
    ip: trimTo(ip, 100),
    ipSource: trimTo(ipSource, STRING_LIMITS.ipSource),
    ipCountry: getCountryCode(req),
    userAgent,
    browserName: trimTo(userAgentSummary.browserName, STRING_LIMITS.browserName),
    osName: trimTo(userAgentSummary.osName, STRING_LIMITS.osName),
    deviceType: trimTo(userAgentSummary.deviceType, STRING_LIMITS.deviceType),
    referrer: trimTo(
      getHeader(req, "referer") || getHeader(req, "referrer"),
      STRING_LIMITS.referrer
    ),
    origin: trimTo(getHeader(req, "origin"), STRING_LIMITS.origin),
    acceptLanguage: trimTo(
      getHeader(req, "accept-language"),
      STRING_LIMITS.acceptLanguage
    ),
    ...clientAudit,
    emailDomain: getEmailDomain(email),
    sameIpSignupCountAtRegistration,
    sameEmailDomainCountAtRegistration,
    sameBrowserContextSignupCountAtRegistration,
  };

  return audit;
}

export function formatUserAgentSummary(audit = {}) {
  const browserName = audit?.browserName || "Unknown";
  const osName = audit?.osName || "Unknown";
  const deviceType = audit?.deviceType || "Unknown";

  if (browserName === "Unknown" && osName === "Unknown" && deviceType === "Unknown") {
    return "";
  }

  return `${browserName} on ${osName} (${deviceType})`;
}

export function formatUtmSummary(utm = {}) {
  const parts = [utm?.source, utm?.medium, utm?.campaign]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return parts.join(" / ");
}
