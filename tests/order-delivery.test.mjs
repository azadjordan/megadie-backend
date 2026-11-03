import test from "node:test";
import assert from "node:assert/strict";
import { buildCartonLabel, getCustomerDeliveryDefaults, resolveOrderDelivery, validateAssignedTo, validateDeliveryDetails } from "../utils/orderDelivery.js";
import { buildFulfillmentSheet } from "../utils/orderFulfillment.js";

const user = { name: "Alpha Beta Company", phoneNumber: "account-phone", address: "Default address", deliveryGoogleMapsUrl: "https://maps.app.goo.gl/example" };
const details = { contactName: "Recipient", phoneNumber: "+123", address: "Order address", secondaryPhoneNumber: "", googleMapsUrl: "", notes: "" };
const order = { _id: "o1", orderNumber: "ORD-261102-023AD", status: "Shipping", user, preparationMode: "prepare_deliver", assignedTo: "Ahmed", deliveryDetails: details, deliveryRevision: 1,
  totalPrice: 9876, adminToAdminNote: "SECRET", orderItems: [{ product: "p1", sku: "SKU1", productName: "Ribbon", qty: 4 }] };
const allocation = (qty, label = "A2-AE1", status = "Reserved", store = "AE1") => ({ product: "p1", qty, status, slot: { label, store } });

test("compact carton label uses initials and the full last order segment", () => {
  assert.equal(buildCartonLabel(user.name, order.orderNumber), "ABC-023AD");
  assert.equal(buildCartonLabel("Jane Mary Doe", "ORD-261102-ABC123"), "JMD-ABC123");
  assert.equal(buildCartonLabel(" أحمد علي ", "ORD-261102-012345"), "أع-012345");
  assert.doesNotMatch(buildCartonLabel("A. B. C.", order.orderNumber), /[.\s]/);
});

test("assignment requires a nonblank trimmed name with a bounded length", () => {
  assert.equal(validateAssignedTo("  Ahmed  "), "Ahmed");
  assert.equal(validateAssignedTo("x".repeat(120)).length, 120);
  for (const value of [null, "", "   ", 1, {}, [], "x".repeat(121)]) assert.throws(() => validateAssignedTo(value));
});

test("staff sheet returns saved assignments and flags older unassigned orders for review", () => {
  assert.equal(buildFulfillmentSheet({ ...order, assignedTo: "Ahmed" }, [allocation(4)]).assignedTo, "Ahmed");
  const unassigned = buildFulfillmentSheet({ ...order, assignedTo: undefined }, [allocation(4)]);
  assert.equal(unassigned.assignedTo, "");
  assert.ok(unassigned.problems.includes("Assign this order before copying."));
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
  assert.equal(sheet.items[0].name, undefined);
  assert.equal(sheet.picks[0].name, undefined);
  assert.doesNotMatch(JSON.stringify(sheet), /SECRET|9876|totalPrice|unitPrice|email|storeAddress/);
});

test("staff sheets need only a delivery location while Courier retains its contact requirements", () => {
  for (const location of [{ address: "Location only" }, { googleMapsUrl: "https://maps.app.goo.gl/place" }]) {
    const locationOnly = { ...order, deliveryDetails: location };
    const sheet = buildFulfillmentSheet(locationOnly, [allocation(4)]);
    assert.deepEqual(sheet.problems, []);
    assert.deepEqual(sheet.delivery.missingFields, []);
    assert.deepEqual(resolveOrderDelivery(locationOnly).missingFields, ["contactName", "phoneNumber"]);
  }
  assert.ok(buildFulfillmentSheet({ ...order, deliveryDetails: {} }, [allocation(4)]).problems.some((p) => p.includes("location is missing")));
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


test("preparation-only needs no destination but retains stock and assignment checks", () => {
  const only = { ...order, preparationMode: "prepare_only", deliveryDetails: undefined };
  const sheet = buildFulfillmentSheet(only, [allocation(4)]);
  assert.deepEqual(sheet.problems, []);
  assert.deepEqual(sheet.preparationProblems, []);
  assert.deepEqual(sheet.customerLocation, { address: user.address, googleMapsUrl: user.deliveryGoogleMapsUrl });
  assert.ok(buildFulfillmentSheet({ ...only, assignedTo: "" }, [allocation(4)]).problems.some((p) => p.includes("Assign")));
  assert.ok(buildFulfillmentSheet(only, [allocation(3)]).problems.some((p) => p.includes("allocated 3")));
  assert.ok(buildFulfillmentSheet({ ...only, preparationMode: "" }, [allocation(4)]).problems.some((p) => p.includes("Choose")));
});
