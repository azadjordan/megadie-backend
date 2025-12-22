// megadie-backend/utils/QuotePDF.js
import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 11, fontFamily: "Helvetica", color: "#333" },
  header: { marginBottom: 20, borderBottom: "1 solid #888", paddingBottom: 10 },

  // Header layout
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  headerLeft: { flexDirection: "column" },
  headerRight: { flexDirection: "column", alignItems: "flex-end" },

  title: { fontSize: 20, fontWeight: "bold", color: "#4B0082" },
  metaText: { fontSize: 10, color: "#555", marginTop: 2 },

  section: { marginBottom: 14 },
  label: { fontWeight: "bold", marginRight: 4 },

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

  // Columns
  cellProduct: { width: "50%" },
  cellQty: { width: "20%", textAlign: "right" },
  cellTotal: { width: "30%", textAlign: "right" },

  totalLine: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 4,
  },
  totalLabel: { width: "70%", textAlign: "right", paddingRight: 8, fontWeight: "bold" },
  totalValue: { width: "30%", textAlign: "right" },
});

const fmtMoney = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0.00";
  return x.toFixed(2);
};

const fmtDate = (d) => {
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return "—";
  }
};

const QuotePDF = ({ quote }) => {
  const items = Array.isArray(quote?.requestedItems) ? quote.requestedItems : [];

  const rows = items.map((item, idx) => {
    const qty = Number(item?.qty) || 0;
    const unit = Number(item?.unitPrice) || 0;
    const lineTotal = Math.max(0, unit * qty);

    // Prefer sku, fallback to name, then fallback label
    const productLabel =
      item?.product?.sku ||
      item?.product?.name ||
      "Unnamed";

    return React.createElement(
      View,
      { style: styles.tableRow, key: `row-${idx}` },
      [
        React.createElement(
          Text,
          { style: styles.cellProduct, key: `product-${idx}` },
          productLabel
        ),
        React.createElement(
          Text,
          { style: styles.cellQty, key: `qty-${idx}` },
          `${qty}`
        ),
        React.createElement(
          Text,
          { style: styles.cellTotal, key: `total-${idx}` },
          fmtMoney(lineTotal)
        ),
      ]
    );
  });

  const quoteNo = quote?.quoteNumber || quote?._id || "—";

  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      [
        // Header
        React.createElement(View, { style: styles.header, key: "header" }, [
          React.createElement(View, { style: styles.headerRow, key: "header-row" }, [
            React.createElement(View, { style: styles.headerLeft, key: "header-left" }, [
              React.createElement(Text, { style: styles.title, key: "title" }, "Quote"),
              React.createElement(Text, { key: "brand" }, "Megadie"),
            ]),
            React.createElement(View, { style: styles.headerRight, key: "header-right" }, [
              React.createElement(Text, { style: styles.metaText, key: "quote-number" }, `Quote #: ${quoteNo}`),
              React.createElement(Text, { style: styles.metaText, key: "created-at" }, `Date: ${fmtDate(quote?.createdAt)}`),
            ]),
          ]),
        ]),

        // Info
        React.createElement(View, { style: styles.section, key: "info" }, [
          React.createElement(Text, { key: "client" }, [
            React.createElement(Text, { style: styles.label }, "Client:"),
            ` ${quote?.user?.name || "Unnamed"}`,
          ]),
          React.createElement(Text, { key: "email" }, [
            React.createElement(Text, { style: styles.label }, "Email:"),
            ` ${quote?.user?.email || "—"}`,
          ]),
          React.createElement(Text, { key: "status" }, [
            React.createElement(Text, { style: styles.label }, "Status:"),
            ` ${quote?.status || "—"}`,
          ]),
        ]),

        // Table Header
        React.createElement(View, { style: styles.tableHeader, key: "table-header" }, [
          React.createElement(Text, { style: styles.cellProduct, key: "th-product" }, "Product"),
          React.createElement(Text, { style: styles.cellQty, key: "th-qty" }, "Qty"),
          React.createElement(Text, { style: styles.cellTotal, key: "th-total" }, "Total"),
        ]),

        // Table Rows
        ...rows,

        // Totals
        React.createElement(View, { style: styles.section, key: "totals" }, [
          React.createElement(View, { style: styles.totalLine, key: "delivery" }, [
            React.createElement(Text, { style: styles.totalLabel }, "Delivery Charge:"),
            React.createElement(Text, { style: styles.totalValue }, fmtMoney(quote?.deliveryCharge)),
          ]),
          React.createElement(View, { style: styles.totalLine, key: "extra" }, [
            React.createElement(Text, { style: styles.totalLabel }, "Extra Fee:"),
            React.createElement(Text, { style: styles.totalValue }, fmtMoney(quote?.extraFee)),
          ]),
          React.createElement(View, { style: styles.totalLine, key: "grand" }, [
            React.createElement(Text, { style: styles.totalLabel }, "Total Price:"),
            React.createElement(Text, { style: styles.totalValue }, fmtMoney(quote?.totalPrice)),
          ]),
        ]),
      ]
    )
  );
};

export default QuotePDF;
