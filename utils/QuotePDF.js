import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

// === Styles ===
const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 11,
    fontFamily: "Helvetica",
    color: "#333",
  },
  header: {
    marginBottom: 20,
    borderBottom: "1 solid #888",
    paddingBottom: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#4B0082",
  },
  section: {
    marginBottom: 14,
  },
  label: {
    fontWeight: "bold",
    marginRight: 4,
  },
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
  cellProduct: {
    width: "50%",
  },
  cellQty: {
    width: "20%",
    textAlign: "right",
  },
  cellTotal: {
    width: "30%",
    textAlign: "right",
  },
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
  totalValue: {
    width: "30%",
    textAlign: "right",
  },
});

// === Component ===
const QuotePDF = ({ quote }) =>
  React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "A4", style: styles.page },

      // Header
      React.createElement(View, { style: styles.header }, [
        React.createElement(Text, { style: styles.title }, "Quote"),
        React.createElement(Text, {}, "Megadie"),
      ]),

      // Quote Info
      React.createElement(View, { style: styles.section }, [
        React.createElement(Text, {}, [
          React.createElement(Text, { style: styles.label }, "Client:"),
          ` ${quote.user?.name || "Unnamed"}`
        ]),
        React.createElement(Text, {}, [
          React.createElement(Text, { style: styles.label }, "Email:"),
          ` ${quote.user?.email || "—"}`
        ]),
        React.createElement(Text, {}, [
          React.createElement(Text, { style: styles.label }, "Date:"),
          ` ${new Date(quote.createdAt).toLocaleDateString()}`
        ]),
        React.createElement(Text, {}, [
          React.createElement(Text, { style: styles.label }, "Status:"),
          ` ${quote.status}`
        ]),
      ]),

      // Items Table
      React.createElement(View, null, [
        React.createElement(View, { style: styles.tableHeader }, [
          React.createElement(Text, { style: styles.cellProduct }, "Product"),
          React.createElement(Text, { style: styles.cellQty }, "Qty"),
          React.createElement(Text, { style: styles.cellTotal }, "Total"),
        ]),
        ...quote.requestedItems.map((item, idx) =>
          React.createElement(View, { key: idx, style: styles.tableRow }, [
            React.createElement(Text, { style: styles.cellProduct }, item.product?.name || "Unnamed"),
            React.createElement(Text, { style: styles.cellQty }, `${item.qty}`),
            React.createElement(Text, { style: styles.cellTotal }, (item.qty * item.unitPrice).toFixed(2)),
          ])
        )
      ]),

      // Totals Section
      React.createElement(View, { style: styles.section }, [
        React.createElement(View, { style: styles.totalLine }, [
          React.createElement(Text, { style: styles.totalLabel }, "Delivery Charge:"),
          React.createElement(Text, { style: styles.totalValue }, quote.deliveryCharge.toFixed(2)),
        ]),
        React.createElement(View, { style: styles.totalLine }, [
          React.createElement(Text, { style: styles.totalLabel }, "Extra Fee:"),
          React.createElement(Text, { style: styles.totalValue }, quote.extraFee.toFixed(2)),
        ]),
        React.createElement(View, { style: styles.totalLine }, [
          React.createElement(Text, { style: styles.totalLabel }, "Total Price:"),
          React.createElement(Text, { style: styles.totalValue }, quote.totalPrice.toFixed(2)),
        ]),
      ])
    )
  );

export default QuotePDF;
