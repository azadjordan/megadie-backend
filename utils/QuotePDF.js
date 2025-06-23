import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

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

const QuotePDF = ({ quote }) => {
  const rows = quote.requestedItems.map((item, idx) =>
    React.createElement(
      View,
      { style: styles.tableRow, key: `row-${idx}` },
      [
        React.createElement(Text, { style: styles.cellProduct, key: `product-${idx}` }, item.product?.name || "Unnamed"),
        React.createElement(Text, { style: styles.cellQty, key: `qty-${idx}` }, `${item.qty}`),
        React.createElement(Text, { style: styles.cellTotal, key: `total-${idx}` }, (item.unitPrice * item.qty).toFixed(2)),
      ]
    )
  );

  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      [
        // Header
        React.createElement(View, { style: styles.header, key: "header" }, [
          React.createElement(Text, { style: styles.title, key: "title" }, "Quote"),
          React.createElement(Text, { key: "brand" }, "Megadie"),
        ]),

        // Info
        React.createElement(View, { style: styles.section, key: "info" }, [
          React.createElement(Text, { key: "client" }, [
            React.createElement(Text, { style: styles.label }, "Client:"),
            ` ${quote.user?.name || "Unnamed"}`,
          ]),
          React.createElement(Text, { key: "email" }, [
            React.createElement(Text, { style: styles.label }, "Email:"),
            ` ${quote.user?.email || "—"}`,
          ]),
          React.createElement(Text, { key: "date" }, [
            React.createElement(Text, { style: styles.label }, "Date:"),
            ` ${new Date(quote.createdAt).toLocaleDateString()}`,
          ]),
          React.createElement(Text, { key: "status" }, [
            React.createElement(Text, { style: styles.label }, "Status:"),
            ` ${quote.status}`,
          ]),
        ]),

        // Table Header
        React.createElement(View, { style: styles.tableHeader, key: "table-header" }, [
          React.createElement(Text, { style: styles.cellProduct }, "Product"),
          React.createElement(Text, { style: styles.cellQty }, "Qty"),
          React.createElement(Text, { style: styles.cellTotal }, "Total"),
        ]),

        // Table Rows
        ...rows,

        // Totals
        React.createElement(View, { style: styles.section, key: "totals" }, [
          React.createElement(View, { style: styles.totalLine }, [
            React.createElement(Text, { style: styles.totalLabel }, "Delivery Charge:"),
            React.createElement(Text, { style: styles.totalValue }, quote.deliveryCharge?.toFixed(2) || "0.00"),
          ]),
          React.createElement(View, { style: styles.totalLine }, [
            React.createElement(Text, { style: styles.totalLabel }, "Extra Fee:"),
            React.createElement(Text, { style: styles.totalValue }, quote.extraFee?.toFixed(2) || "0.00"),
          ]),
          React.createElement(View, { style: styles.totalLine }, [
            React.createElement(Text, { style: styles.totalLabel }, "Total Price:"),
            React.createElement(Text, { style: styles.totalValue }, quote.totalPrice?.toFixed(2) || "0.00"),
          ]),
        ]),
      ]
    )
  );
};

export default QuotePDF;
