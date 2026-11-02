import test from "node:test";
import assert from "node:assert/strict";
import { buildCartonLabel, getCustomerDeliveryDefaults, resolveOrderDelivery, validateDeliveryDetails } from "../utils/orderDelivery.js";
import { buildFulfillmentSheet } from "../utils/orderFulfillment.js";

const user = { name: "Alpha Beta Company", phoneNumber: "account-phone", address: "Default address", deliveryGoogleMapsUrl: "https://maps.app.goo.gl/example" };
const details = { contactName: "Recipient", phoneNumber: "+123", address: "Order address", secondaryPhoneNumber: "", googleMapsUrl: "", notes: "" };
const order = { _id: "o1", orderNumber: "ORD-261102-023AD", status: "Shipping", user, deliveryDetails: details, deliveryRevision: 1,
  totalPrice: 9876, adminToAdminNote: "SECRET", orderItems: [{ product: "p1", sku: "SKU1", productName: "Ribbon", qty: 4 }] };
const allocation = (qty, label = "A2-AE1", status = "Reserved", store = "AE1") => ({ product: "p1", qty, status, slot: { label, store } });

test("compact carton label uses initials and the full last order segment", () => {
  assert.equal(buildCartonLabel(user.name, order.orderNumber), "ABC-023AD");
  assert.equal(buildCartonLabel("Jane Mary Doe", "ORD-261102-ABC123"), "JMD-ABC123");
  assert.equal(buildCartonLabel(" أحمد علي ", "ORD-261102-012345"), "أع-012345");
  assert.doesNotMatch(buildCartonLabel("A. B. C.", order.orderNumber), /[.\s]/);
});

test("default contacts can differ from account identity and blank overrides restore inheritance", () => {
  assert.equal(getCustomerDeliveryDefaults({ ...user, deliveryPhoneNumber: "reception" }).phoneNumber, "reception");
  assert.equal(getCustomerDeliveryDefaults({ ...user, deliveryContactName: "Desk" }).contactName, "Desk");
  assert.equal(getCustomerDeliveryDefaults({ ...user, deliveryPhoneNumber: " " }).phoneNumber, user.phoneNumber);
  assert.equal(getCustomerDeliveryDefaults(null).contactName, "");
});

test("saved delivery is authoritative, including deliberate blanks", () => {
  const saved = resolveOrderDelivery({ ...order, deliveryDetails: { ...details, address: "", googleMapsUrl: "" } });
  assert.equal(saved.details.address, "");
  assert.ok(saved.missingFields.includes("addressOrLocation"));
  assert.equal(saved.savedToOrder, true);
  const legacy = resolveOrderDelivery({ ...order, deliveryDetails: undefined, deliveryRevision: undefined });
  assert.equal(legacy.savedToOrder, false);
  assert.equal(legacy.revision, 0);
  assert.equal(legacy.details.address, user.address);
  assert.equal(resolveOrderDelivery({ ...order, status: "Delivered", deliveryDetails: undefined }).details, null);
});

test("edited delivery values are bounded strings and map links must be HTTPS", () => {
  assert.equal(validateDeliveryDetails({ ...details, contactName: "  Desk  " }).contactName, "Desk");
  assert.equal(validateDeliveryDetails({}).address, "");
  for (const invalid of [null, [], { phoneNumber: 123 }, { extra: "x" }, { address: "x".repeat(2001) }, { googleMapsUrl: "javascript:alert(1)" }, { googleMapsUrl: "http://maps.example" }, { googleMapsUrl: "https://user:pass@example.com" }, { toString: "bad" }]) {
    assert.throws(() => validateDeliveryDetails(invalid));
  }
});

test("sheet naturally sorts slots, aggregates duplicate order lines, and allowlists data", () => {
  const sheet = buildFulfillmentSheet({ ...order, orderItems: [...order.orderItems, { ...order.orderItems[0], qty: 2 }] }, [allocation(2, "A10-AE1"), allocation(4)]);
  assert.deepEqual(sheet.problems, []);
  assert.equal(sheet.label, "ABC-023AD");
  assert.deepEqual(sheet.picks.map((p) => p.slot), ["A2-AE1", "A10-AE1"]);
  assert.equal(sheet.items[0].orderedQty, 6);
  assert.equal(sheet.items[0].allocatedQty, 6);
  assert.doesNotMatch(JSON.stringify(sheet), /SECRET|9876|totalPrice|unitPrice|email|storeAddress/);
});

test("allocation problems produce drafts rather than silently dropping discrepancies", () => {
  for (const rows of [[allocation(3)], [allocation(5)], [allocation(4, "A1-AE2", "Reserved", "AE2")], [allocation(4, "")], [allocation(1.5)], [allocation(4), { ...allocation(1), product: "outside" }]]) {
    assert.ok(buildFulfillmentSheet(order, rows).problems.length);
  }
  assert.deepEqual(buildFulfillmentSheet(order, [allocation(4), allocation(6, "CANCELLED", "Cancelled")]).problems, []);
  const mixed = buildFulfillmentSheet(order, [allocation(2), allocation(2, "A3-AE1", "Deducted")]);
  assert.ok(mixed.problems.some((p) => p.includes("partly deducted")));
  assert.ok(mixed.notices.some((p) => p.includes("physically")));
});
