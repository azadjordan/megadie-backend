import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

// === Styles ===
const styles = StyleSheet.create({
  // Extra bottom padding so content never overlaps the fixed footer
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

  // Two-column meta grid under header
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

  // === Repeated Footer ===
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

// Helpers
const asNumber = (v) => {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
};

const safe = (v) => (v === 0 ? "0" : v ? String(v) : "—");

const money = (n) => asNumber(n).toFixed(2);

const InvoicePDF = ({ invoice, order, company }) => {
  const deliveryCharge = asNumber(
    invoice?.deliveryCharge ?? order?.deliveryCharge ?? 0
  );
  const extraFee = asNumber(invoice?.extraFee ?? order?.extraFee ?? 0);

  const year =
    (invoice?.createdAt && new Date(invoice.createdAt).getFullYear()) ||
    new Date().getFullYear();

  const itemRows = order.orderItems.map((item, idx) =>
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
        (asNumber(item.unitPrice) * asNumber(item.qty)).toFixed(2)
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
        React.createElement(Text, { style: styles.brand }, "Megadie"),
      ]),

      // === Two-Column Meta Section ===
      React.createElement(View, { style: styles.metaWrap, key: "meta" }, [
        React.createElement(View, { style: styles.metaGrid }, [
          // Left column
          React.createElement(
            View,
            { style: styles.metaCol, key: "meta-left" },
            [
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-inv" },
                [
                  React.createElement(
                    Text,
                    { style: styles.label },
                    "Invoice #"
                  ),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    safe(invoice.invoiceNumber || invoice._id)
                  ),
                ]
              ),
              // Invoiced By (directly under Invoice #)
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-invoicedby" },
                [
                  React.createElement(
                    Text,
                    { style: styles.label },
                    "Invoiced By"
                  ),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    "Megadie.com"
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
            ]
          ),

          // Right column
          React.createElement(
            View,
            { style: styles.metaCol, key: "meta-right" },
            [
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
              // Status
              React.createElement(
                View,
                { style: styles.metaRow, key: "m-status" },
                [
                  React.createElement(Text, { style: styles.label }, "Status"),
                  React.createElement(Text, { style: styles.colon }, ":"),
                  React.createElement(
                    Text,
                    { style: styles.value },
                    safe(invoice.status)
                  ),
                ]
              ),
            ]
          ),
        ]),
      ]),

      // === Table Header ===
      React.createElement(
        View,
        { style: styles.tableHeader, key: "table-header" },
        [
          React.createElement(Text, { style: styles.cellProduct }, "Product"),
          React.createElement(Text, { style: styles.cellQty }, "Qty"),
          React.createElement(Text, { style: styles.cellTotal }, "Total"),
        ]
      ),

      // === Table Rows ===
      ...itemRows,

      // === Totals ===
      React.createElement(View, { style: styles.section, key: "totals" }, [
        React.createElement(
          View,
          { style: styles.totalLine, key: "delivery" },
          [
            React.createElement(
              Text,
              { style: styles.totalLabel },
              "Delivery Charge:"
            ),
            React.createElement(
              Text,
              { style: styles.totalValue },
              money(deliveryCharge)
            ),
          ]
        ),
        React.createElement(
          View,
          { style: styles.totalLine, key: "extrafee" },
          [
            React.createElement(
              Text,
              { style: styles.totalLabel },
              "Extra Fee:"
            ),
            React.createElement(
              Text,
              { style: styles.totalValue },
              money(extraFee)
            ),
          ]
        ),
        React.createElement(View, { style: styles.totalLine }, [
          React.createElement(
            Text,
            { style: styles.totalLabel },
            "Total Amount:"
          ),
          React.createElement(
            Text,
            { style: styles.totalValue },
            money(invoice.amountDue)
          ),
        ]),
        React.createElement(View, { style: styles.totalLine }, [
          React.createElement(
            Text,
            { style: styles.totalLabel },
            "Amount Paid:"
          ),
          React.createElement(
            Text,
            { style: styles.totalValue },
            money(invoice.amountPaid)
          ),
        ]),
        React.createElement(View, { style: styles.totalLine }, [
          React.createElement(
            Text,
            { style: styles.totalLabel },
            "Remaining Unpaid:"
          ),
          React.createElement(
            Text,
            { style: styles.totalValue },
            `AED ${money(
              asNumber(invoice.amountDue) - asNumber(invoice.amountPaid)
            )}`
          ),
        ]),
      ]),

      // === Minimal Professional Footer ===
      React.createElement(
        View,
        { style: styles.footerWrap, fixed: true, key: "footerWrap" },
        [
          React.createElement(View, { style: styles.footer, key: "footer" }, [
            // Left brand
            React.createElement(
              Text,
              { style: [styles.fCol, styles.fLeft], key: "f-left" },
              React.createElement(Text, { style: styles.fBrand }, "Megadie")
            ),
            // Center T&C link
            React.createElement(
              Text,
              { style: [styles.fCol, styles.fCenter], key: "f-center" },
              "Read T&C at www.megadie.com"
            ),
            // Right copyright + page numbers
            React.createElement(
              Text,
              { style: [styles.fCol, styles.fRight], key: "f-right" },
              [
                `© ${year} Megadie — All rights reserved • `,
                React.createElement(Text, {
                  key: "page-count",
                  render: ({ pageNumber, totalPages }) =>
                    `Page ${pageNumber} of ${totalPages}`,
                }),
              ]
            ),
          ]),
        ]
      ),
    ])
  );
};

export default InvoicePDF;
