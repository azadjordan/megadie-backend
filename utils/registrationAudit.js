import net from "net";

const STRING_LIMITS = {
  userAgent: 500,
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

const EXPECTED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "https://megadie-frontend.onrender.com",
  "https://megadie-frontend-v2.onrender.com",
  "https://www.megadie.com",
  "https://megadie.com",
]);

const RISK_FLAG_LABELS = {
  same_ip_signup: "Another signup used this IP",
  multiple_same_ip_signups: "Several signups used this IP",
  same_email_domain_signup: "Another signup used this email domain",
  multiple_same_email_domain_signups: "Several signups used this email domain",
  very_fast_signup: "Very fast form completion",
  missing_client_audit: "Missing browser context",
  missing_user_agent: "Missing user agent",
  unexpected_origin: "Unexpected registration origin",
};

const RISK_LEVEL_LABELS = {
  Low: "Looks normal",
  Medium: "Review recommended",
  High: "Review carefully",
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

function hasClientAuditValues(clientAudit) {
  return Object.values(clientAudit).some((value) => value !== undefined);
}

function getHeader(req, name) {
  return firstHeaderValue(req?.headers?.[name]);
}

function isExpectedOrigin(origin) {
  if (!origin) return true;
  if (EXPECTED_ORIGINS.has(origin)) return true;

  const frontendUrl = trimTo(process.env.FRONTEND_URL, 250);
  if (!frontendUrl) return false;

  try {
    return new URL(origin).origin === new URL(frontendUrl).origin;
  } catch {
    return false;
  }
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
  return (
    normalizeIp(req?.ip) ||
    normalizeIp(getHeader(req, "cf-connecting-ip")) ||
    normalizeIp(getHeader(req, "true-client-ip")) ||
    normalizeIp(getHeader(req, "x-real-ip")) ||
    normalizeIp(req?.socket?.remoteAddress)
  );
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

export function buildRiskFlags(audit, { clientAuditProvided = false } = {}) {
  const flags = [];
  const sameIpCount = Number(audit.sameIpSignupCountAtRegistration) || 0;
  const sameEmailDomainCount =
    Number(audit.sameEmailDomainCountAtRegistration) || 0;

  if (sameIpCount > 0) flags.push("same_ip_signup");
  if (sameIpCount >= 3) flags.push("multiple_same_ip_signups");
  if (sameEmailDomainCount > 0) flags.push("same_email_domain_signup");
  if (sameEmailDomainCount >= 3) {
    flags.push("multiple_same_email_domain_signups");
  }
  if (
    audit.signupDurationMs !== undefined &&
    Number(audit.signupDurationMs) > 0 &&
    Number(audit.signupDurationMs) <= 3000
  ) {
    flags.push("very_fast_signup");
  }
  if (!clientAuditProvided) flags.push("missing_client_audit");
  if (!audit.userAgent) flags.push("missing_user_agent");
  if (!isExpectedOrigin(audit.origin)) flags.push("unexpected_origin");

  return flags;
}

export function getRiskLevel(flags = [], audit = {}) {
  const meaningfulFlags = flags.filter(
    (flag) =>
      ![
        "missing_client_audit",
        "same_email_domain_signup",
        "multiple_same_email_domain_signups",
      ].includes(flag)
  );
  const sameIpCount = Number(audit.sameIpSignupCountAtRegistration) || 0;

  if (sameIpCount >= 3 || meaningfulFlags.length >= 3) return "High";
  if (meaningfulFlags.length > 0) return "Medium";
  return "Low";
}

export function buildRegistrationAudit({
  req,
  email,
  ip = getRequestIp(req),
  sameIpSignupCount = 0,
  sameEmailDomainCount = 0,
} = {}) {
  const clientAuditProvided = isPlainObject(req?.body?.clientAudit);
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
  const userAgent = trimTo(getHeader(req, "user-agent"), STRING_LIMITS.userAgent);
  const userAgentSummary = parseUserAgent(userAgent);

  const audit = {
    capturedAt: new Date(),
    ip: trimTo(ip, 100),
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
  };

  const effectiveClientAuditProvided =
    clientAuditProvided && hasClientAuditValues(clientAudit);
  const riskFlags = buildRiskFlags(audit, {
    clientAuditProvided: effectiveClientAuditProvided,
  });

  return {
    ...audit,
    riskFlags,
    riskLevel: getRiskLevel(riskFlags, audit),
  };
}

export function formatRiskFlags(flags = []) {
  if (!Array.isArray(flags) || flags.length === 0) return "";
  return flags.map((flag) => RISK_FLAG_LABELS[flag] || flag).join(", ");
}

export function formatRiskLevel(riskLevel) {
  return RISK_LEVEL_LABELS[riskLevel] || riskLevel || "";
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
