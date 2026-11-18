import User from "../models/userModel.js";
import { getCustomerLocation, validateDeliveryDetails, validateLocationChange } from "./orderDelivery.js";

export class CustomerLocationError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

// Both profile editors and order dialogs use this guard. The save predicate
// protects the entire profile write, including concurrent changes after the read.
export function assignCustomerLocation(user, body) {
  if (!Object.hasOwn(body, "address") && !Object.hasOwn(body, "deliveryGoogleMapsUrl")) return;
  const expected = body.expectedCustomerLocation;
  if (!expected || typeof expected.address !== "string" || typeof expected.googleMapsUrl !== "string") {
    throw new CustomerLocationError("Reload the client's default location before saving.");
  }
  const current = getCustomerLocation(user);
  if (current.address !== expected.address.trim() || current.googleMapsUrl !== expected.googleMapsUrl.trim()) {
    throw new CustomerLocationError("Client default location changed. Reload and review before saving.", 409);
  }
  let next;
  try {
    next = validateDeliveryDetails({ address: body.address ?? current.address, googleMapsUrl: body.deliveryGoogleMapsUrl ?? current.googleMapsUrl });
    // Explicit nulls are not a way to bypass string validation or clear fields.
    if (Object.hasOwn(body, "address") && typeof body.address !== "string") throw new Error("Address must be text.");
    if (Object.hasOwn(body, "deliveryGoogleMapsUrl") && typeof body.deliveryGoogleMapsUrl !== "string") throw new Error("Map link must be text.");
    validateLocationChange(current, next, body.confirmedMapLocation);
  } catch (error) { throw new CustomerLocationError(error.message); }
  user.$where = { ...user.$where, address: user.address ?? null, deliveryGoogleMapsUrl: user.deliveryGoogleMapsUrl ?? null };
  user.address = next.address;
  user.deliveryGoogleMapsUrl = next.googleMapsUrl;
  user.markModified("address");
  user.markModified("deliveryGoogleMapsUrl");
}

export async function saveCustomerProfile(user, body, options) {
  assignCustomerLocation(user, body);
  try { return await user.save(options); }
  catch (error) {
    if (error.name === "DocumentNotFoundError" && user.$where) {
      throw new CustomerLocationError("Client default location changed. Reload and review before saving.", 409);
    }
    throw error;
  }
}

export async function saveCustomerLocation({ customerId, details, expectedCustomerLocation, confirmedMapLocation, session }) {
  const user = await User.findById(customerId).session(session);
  if (!user) throw new CustomerLocationError("Client not found.", 404);
  if (!details.address && !details.googleMapsUrl) throw new CustomerLocationError("Add an address or map before saving a client default.");
  return saveCustomerProfile(user, { address: details.address, deliveryGoogleMapsUrl: details.googleMapsUrl, expectedCustomerLocation, confirmedMapLocation }, { session });
}
