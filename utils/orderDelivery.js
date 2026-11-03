const clean = (value) => typeof value === "string" ? value.trim() : "";

export const DELIVERY_FIELDS = {
  contactName: 200,
  phoneNumber: 50,
  secondaryPhoneNumber: 50,
  address: 2000,
  googleMapsUrl: 2048,
  notes: 1000,
};

export const normalizeDeliveryDetails = (value = {}) => Object.fromEntries(
  Object.keys(DELIVERY_FIELDS).map((key) => [key, clean(value?.[key])])
);

export const PREPARATION_MODES = ["prepare_only", "prepare_deliver"];

export function validatePreparationMode(value) {
  if (!PREPARATION_MODES.includes(value)) throw new Error("Choose Prepare Only or Prepare & Deliver.");
  return value;
}

export const getCustomerLocation = (user) => ({
  address: clean(user?.address), googleMapsUrl: clean(user?.deliveryGoogleMapsUrl),
});

export function validateAssignedTo(value) {
  if (typeof value === "string" && !value.trim()) {
    throw new Error("Assigned To is required.");
  }
  if (typeof value !== "string" || value.trim().length > 120) {
    throw new Error("Assigned To must be a name of at most 120 characters.");
  }
  return value.trim();
}

export function validateDeliveryDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Delivery details must be an object.");
  }
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(DELIVERY_FIELDS, key) || typeof raw !== "string") {
      throw new Error(`Invalid delivery field: ${key}.`);
    }
    if (raw.trim().length > DELIVERY_FIELDS[key]) {
      throw new Error(`${key} is too long (maximum ${DELIVERY_FIELDS[key]} characters).`);
    }
  }
  const details = normalizeDeliveryDetails(value);
  if (details.googleMapsUrl) {
    let url;
    try { url = new URL(details.googleMapsUrl); } catch { /* validated below */ }
    if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      throw new Error("Map location must be a valid HTTPS link.");
    }
  }
  return details;
}

export const getCustomerDeliveryDefaults = (user) => {
  user ||= {};
  return normalizeDeliveryDetails({
    contactName: clean(user.deliveryContactName) || user.name,
    phoneNumber: clean(user.deliveryPhoneNumber) || user.phoneNumber,
    secondaryPhoneNumber: user.secondaryPhoneNumber,
    address: user.address,
    googleMapsUrl: user.deliveryGoogleMapsUrl,
    notes: user.deliveryNotes,
  });
};

export function getDeliveryMissingFields(value) {
  const details = normalizeDeliveryDetails(value);
  const missing = [];
  if (!details.contactName) missing.push("contactName");
  if (!details.phoneNumber) missing.push("phoneNumber");
  if (!details.address && !details.googleMapsUrl) missing.push("addressOrLocation");
  return missing;
}

export function resolveOrderDelivery(order) {
  const savedToOrder = order.deliveryDetails != null;
  const active = ["Processing", "Shipping"].includes(order.status);
  const details = savedToOrder
    ? normalizeDeliveryDetails(order.deliveryDetails)
    : active ? getCustomerDeliveryDefaults(order.user) : null;
  return {
    details,
    savedToOrder,
    revision: order.deliveryRevision || 0,
    missingFields: getDeliveryMissingFields(details),
  };
}

export const deliveryRevisionFilter = (revision) => revision === 0
  ? { $or: [{ deliveryRevision: 0 }, { deliveryRevision: { $exists: false } }] }
  : { deliveryRevision: revision };

export function buildCartonLabel(name, orderNumber, fallbackId = "") {
  const words = clean(name).normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
  const initials = words.map((word) => [...word][0]).join("").toUpperCase() || "ORD";
  const suffix = (clean(orderNumber).split("-").at(-1) || clean(fallbackId).slice(-6))
    .replace(/[^\p{L}\p{N}]/gu, "").toUpperCase() || "UNKNOWN";
  return `${initials}-${suffix}`;
}
