import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

// === Styles ===
const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 11, fontFamily: "Helvetica", color: "#333" },
  header: { marginBottom: 20, borderBottom: "1 solid #888", paddingBottom: 10 },
  title: { fontSize: 20, fontWeight: "bold", color: "#4B0082" },
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

const InvoicePDF = ({ invoice, order }) => {
  const itemRows = order.orderItems.map((item, idx) =>
    React.createElement(View, { key: `item-${idx}`, style: styles.tableRow }, [
      React.createElement(Text, { style: styles.cellProduct }, item.product?.name || "Unnamed"),
      React.createElement(Text, { style: styles.cellQty }, `${item.qty}`),
      React.createElement(Text, { style: styles.cellTotal }, (item.unitPrice * item.qty).toFixed(2)),
    ])
  );

  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      [
        // === Header ===
        React.createElement(View, { style: styles.header, key: "header" }, [
          React.createElement(Text, { style: styles.title }, "Invoice"),
          React.createElement(Text, null, "Megadie"),
        ]),

        // === Info Section ===
        React.createElement(View, { style: styles.section, key: "info" }, [
          React.createElement(Text, null, [
            React.createElement(Text, { style: styles.label }, "Invoice #:"),
            ` ${invoice.invoiceNumber || invoice._id}`,
          ]),
          React.createElement(Text, null, [
            React.createElement(Text, { style: styles.label }, "Date:"),
            ` ${new Date(invoice.createdAt).toLocaleDateString()}`,
          ]),
          React.createElement(Text, null, [
            React.createElement(Text, { style: styles.label }, "Status:"),
            ` ${invoice.status}`,
          ]),
          React.createElement(Text, null, [
            React.createElement(Text, { style: styles.label }, "Client:"),
            ` ${invoice.user?.name || "Unnamed"}`,
          ]),
          React.createElement(Text, null, [
            React.createElement(Text, { style: styles.label }, "Email:"),
            ` ${invoice.user?.email || "—"}`,
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
          React.createElement(View, { style: styles.totalLine }, [
            React.createElement(Text, { style: styles.totalLabel }, "Amount Due:"),
            React.createElement(Text, { style: styles.totalValue }, invoice.amountDue.toFixed(2)),
          ]),
          React.createElement(View, { style: styles.totalLine }, [
            React.createElement(Text, { style: styles.totalLabel }, "Amount Paid:"),
            React.createElement(Text, { style: styles.totalValue }, invoice.amountPaid.toFixed(2)),
          ]),
          React.createElement(View, { style: styles.totalLine }, [
            React.createElement(Text, { style: styles.totalLabel }, "Remaining Balance:"),
            React.createElement(Text, { style: styles.totalValue }, (invoice.amountDue - invoice.amountPaid).toFixed(2)),
          ]),
        ]),
      ]
    )
  );
};

export default InvoicePDF;
