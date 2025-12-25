import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

// === Styles ===
const styles = StyleSheet.create({
  page: {
    padding: 40,
    paddingBottom: 100,
    fontSize: 11,
    fontFamily: "Helvetica",
    color: "#333",
  },

  // Header
  header: { marginBottom: 14, borderBottom: "1 solid #888", paddingBottom: 10 },
  title: { fontSize: 20, fontWeight: "bold", color: "#4B0082" },
  brand: { fontSize: 11, marginTop: 2 },
  brandSub: { fontSize: 9, color: "#666", marginTop: 2 },

  // Two-column meta grid
  metaWrap: { marginTop: 10, marginBottom: 10 },
  metaGrid: { flexDirection: "row", gap: 12 },
  metaCol: { width: "50%" },
  metaRow: { flexDirection: "row", marginBottom: 6, flexWrap: "wrap" },
  label: { fontWeight: "bold" },
  colon: { marginHorizontal: 4 },
  value: {},

  section: { marginBottom: 14 },

  // Table
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f0f0f0",
    borderTop: "1 solid #000",
    borderBottom: "1 solid #000",
    padding: 6,
  },
  tableRow: {
    flexDirection: "row",
    borderBottom: "1 solid #ccc",
    padding: 6,
  },
  cellProduct: { width: "50%" },
  cellQty: { width: "20%", textAlign: "right" },
  cellTotal: { width: "30%", textAlign: "right" },

  // Totals
  totalLine: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 4,
  },
  totalLabel: {
    width: "70%",
    textAlign: "right",
    paddingRight: 8,
    fontWeight: "bold",
  },
  totalValue: { width: "30%", textAlign: "right" },

  // Footer
  footerWrap: {
    position: "absolute",
    bottom: 20,
    left: 40,
    right: 40,
  },
  footer: {
    borderTop: "1 solid #d0d0d0",
    paddingTop: 8,
    fontSize: 9,
    color: "#666",
    flexDirection: "row",
    alignItems: "center",
  },
  fCol: { flex: 1 },
  fLeft: { textAlign: "left" },
  fCenter: { textAlign: "center" },
  fRight: { textAlign: "right" },
  fBrand: { fontWeight: "bold", color: "#4B0082" },
});

// === Helpers ===
const asNumber = (v) => {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
};

const safe = (v) => (v === 0 ? "0" : v ? String(v) : "—");
const money = (n, digits = 2) => asNumber(n).toFixed(digits);

const fractionDigitsFromFactor = (factor) => {
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0) return 2;
  if (f === 1) return 0;
  const pow = Math.log10(f);
  return Number.isInteger(pow) ? pow : 2;
};

const minorToMajor = (minor, factor) => {
  const n = asNumber(minor);
  const f = Number(factor);
  const safeFactor = Number.isFinite(f) && f > 0 ? f : 100;
  return n / safeFactor;
};

const InvoicePDF = ({ invoice, order, company }) => {
  const factor = Number(invoice?.minorUnitFactor);
  const minorUnitFactor = Number.isFinite(factor) && factor > 0 ? factor : 100;
  const fractionDigits = fractionDigitsFromFactor(minorUnitFactor);

  // Charges live on the order; invoice.amountMinor is the official total
  const deliveryCharge = asNumber(order?.deliveryCharge ?? 0);
  const extraFee = asNumber(order?.extraFee ?? 0);

  // Subtotal from order items (qty * unitPrice)
  const subtotal = Array.isArray(order?.orderItems)
    ? order.orderItems.reduce(
        (sum, it) => sum + asNumber(it.unitPrice) * asNumber(it.qty),
        0
      )
    : 0;

  // Prefer the single source of truth from the Invoice model.
  // Fallback: derive from subtotal + charges if amount is missing.
  const invoiceAmount = Number.isFinite(Number(invoice?.amountMinor))
    ? minorToMajor(invoice.amountMinor, minorUnitFactor)
    : subtotal + deliveryCharge + extraFee;

  // Payments: if controller precomputed totalPaid/balanceDue use them,
  // otherwise derive from payments (Received) as a fallback.
  const paymentsArray = Array.isArray(invoice?.payments)
    ? invoice.payments
    : [];

  const receivedPaymentsTotal = paymentsArray.reduce((sum, p) => {
    if (p && typeof p.amountMinor === "number") {
      return sum + minorToMajor(p.amountMinor, minorUnitFactor);
    }
    if (p && typeof p.amount === "number") {
      return sum + asNumber(p.amount);
    }
    return sum;
  }, 0);

  const amountPaid = Number.isFinite(Number(invoice?.paidTotalMinor))
    ? minorToMajor(invoice.paidTotalMinor, minorUnitFactor)
    : receivedPaymentsTotal;

  const balanceDue = Number.isFinite(Number(invoice?.balanceDueMinor))
    ? minorToMajor(invoice.balanceDueMinor, minorUnitFactor)
    : Math.max(invoiceAmount - amountPaid, 0);

  const year =
    (invoice?.createdAt && new Date(invoice.createdAt).getFullYear()) ||
    new Date().getFullYear();

  // Table rows from order items
  const itemRows = (order?.orderItems ?? []).map((item, idx) =>
    React.createElement(View, { key: `item-${idx}`, style: styles.tableRow }, [
      React.createElement(
        Text,
        { style: styles.cellProduct },
        item.product?.name || "Unnamed"
      ),
      React.createElement(Text, { style: styles.cellQty }, `${item.qty}`),
      React.createElement(
        Text,
        { style: styles.cellTotal },
        money(asNumber(item.unitPrice) * asNumber(item.qty), fractionDigits)
      ),
    ])
  );

  return React.createElement(
    Document,
    null,
    React.createElement(Page, { size: "A4", style: styles.page }, [
      // === Header ===
      React.createElement(View, { style: styles.header, key: "header" }, [
        React.createElement(Text, { style: styles.title }, "Invoice"),
        React.createElement(Text, { style: styles.brand }, company?.name || "Megadie"),
        company?.sub && React.createElement(Text, { style: styles.brandSub }, company.sub),
      ]),

      // === Meta (two columns) ===
      React.createElement(View, { style: styles.metaWrap, key: "meta" }, [
        React.createElement(View, { style: styles.metaGrid }, [
          // Left column
          React.createElement(
            View,
            { style: styles.metaCol, key: "meta-left" },
            [
              // Invoice #
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-inv" },
                [
                  React.createElement(Text, { style: styles.label }, "Invoice #"),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    safe(invoice.invoiceNumber || invoice._id)
                  ),
                ]
              ),
              // Invoiced By
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-invoicedby" },
                [
                  React.createElement(Text, { style: styles.label }, "Invoiced By"),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    company?.display || "Megadie.com"
                  ),
                ]
              ),
              // Date
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-date" },
                [
                  React.createElement(Text, { style: styles.label }, "Date"),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    invoice.createdAt
                      ? new Date(invoice.createdAt).toLocaleDateString()
                      : "—"
                  ),
                ]
              ),
              // Due Date
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-due" },
                [
                  React.createElement(Text, { style: styles.label }, "Due Date"),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    invoice.dueDate
                      ? new Date(invoice.dueDate).toLocaleDateString()
                      : "—"
                  ),
                ]
              ),
            ]
          ),

          // Right column
          React.createElement(
            View,
            { style: styles.metaCol, key: "meta-right" },
            [
              // Client
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-client" },
                [
                  React.createElement(Text, { style: styles.label }, "Client"),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    safe(invoice.user?.name)
                  ),
                ]
              ),
              // Email
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-email" },
                [
                  React.createElement(Text, { style: styles.label }, "Email"),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    safe(invoice.user?.email)
                  ),
                ]
              ),
              // Order #
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-ordernum" },
                [
                  React.createElement(Text, { style: styles.label }, "Order #"),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    safe(order?.orderNumber)
                  ),
                ]
              ),
              // Payment Status
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-status" },
                [
                  React.createElement(Text, { style: styles.label }, "Status"),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    safe(invoice.paymentStatus || "Unpaid")
                  ),
                ]
              ),
            ]
          ),
        ]),
      ]),

      // === Table Header ===
      React.createElement(View, { style: styles.tableHeader, key: "table-header" }, [
        React.createElement(Text, { style: styles.cellProduct }, "Product"),
        React.createElement(Text, { style: styles.cellQty }, "Qty"),
        React.createElement(Text, { style: styles.cellTotal }, "Total"),
      ]),

      // === Table Rows ===
      ...itemRows,

      // === Totals ===
      React.createElement(View, { style: styles.section, key: "totals" }, [
        React.createElement(View, { style: styles.totalLine, key: "subtotal" }, [
          React.createElement(Text, { style: styles.totalLabel }, "Subtotal:"),
          React.createElement(
            Text,
            { style: styles.totalValue },
            money(subtotal, fractionDigits)
          ),
        ]),

        React.createElement(View, { style: styles.totalLine, key: "delivery" }, [
          React.createElement(Text, { style: styles.totalLabel }, "Delivery Charge:"),
          React.createElement(
            Text,
            { style: styles.totalValue },
            money(deliveryCharge, fractionDigits)
          ),
        ]),

        React.createElement(View, { style: styles.totalLine, key: "extrafee" }, [
          React.createElement(Text, { style: styles.totalLabel }, "Extra Fee:"),
          React.createElement(
            Text,
            { style: styles.totalValue },
            money(extraFee, fractionDigits)
          ),
        ]),

        React.createElement(View, { style: styles.totalLine, key: "grand" }, [
          React.createElement(Text, { style: styles.totalLabel }, "Invoice Amount:"),
          React.createElement(
            Text,
            { style: styles.totalValue },
            money(invoiceAmount, fractionDigits)
          ),
        ]),

        React.createElement(View, { style: styles.totalLine, key: "paid" }, [
          React.createElement(Text, { style: styles.totalLabel }, "Amount Paid:"),
          React.createElement(
            Text,
            { style: styles.totalValue },
            money(amountPaid, fractionDigits)
          ),
        ]),

        React.createElement(View, { style: styles.totalLine, key: "due" }, [
          React.createElement(Text, { style: styles.totalLabel }, "Balance Due:"),
          React.createElement(
            Text,
            { style: styles.totalValue },
            money(balanceDue, fractionDigits)
          ),
        ]),
      ]),

      // === Footer ===
      React.createElement(View, { style: styles.footerWrap, fixed: true, key: "footerWrap" }, [
        React.createElement(View, { style: styles.footer, key: "footer" }, [
          React.createElement(
            Text,
            { style: [styles.fCol, styles.fLeft], key: "f-left" },
            React.createElement(Text, { style: styles.fBrand }, company?.short || "Megadie")
          ),
          React.createElement(
            Text,
            { style: [styles.fCol, styles.fCenter], key: "f-center" },
            company?.footer || "Read T&C at www.megadie.com"
          ),
          React.createElement(Text, { style: [styles.fCol, styles.fRight], key: "f-right" }, [
            `© ${year} ${company?.short || "Megadie"} — All rights reserved • `,
            React.createElement(Text, {
              key: "page-count",
              render: ({ pageNumber, totalPages }) =>
                `Page ${pageNumber} of ${totalPages}`,
            }),
          ]),
        ]),
      ]),
    ])
  );
};

export default InvoicePDF;
