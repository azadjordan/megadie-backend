function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value?._id || value?.id || value || "");
}

function getAmountMinor(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)) : 0;
}

function resolveInvoiceDate(invoice) {
  return toDate(invoice?.invoiceDate) || toDate(invoice?.createdAt);
}

function resolvePaymentDate(payment) {
  return toDate(payment?.paymentDate) || toDate(payment?.createdAt);
}

function sortTime(value) {
  const date = toDate(value);
  if (!date) return Number.MAX_SAFE_INTEGER;
  return date.getTime();
}

function sortDayTime(value) {
  const date = toDate(value);
  if (!date) return Number.MAX_SAFE_INTEGER;
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function startOfDubaiDay(value) {
  const date = toDate(value) || new Date();
  const dubaiOffsetMs = 4 * 60 * 60 * 1000;
  const shifted = new Date(date.getTime() + dubaiOffsetMs);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate()
    ) - dubaiOffsetMs
  );
}

function isBefore(dateValue, boundary) {
  const time = sortTime(dateValue);
  const boundaryTime = sortTime(boundary);
  return Number.isFinite(time) && time < boundaryTime;
}

function isOnOrAfter(dateValue, boundary) {
  if (!boundary) return true;
  const time = sortTime(dateValue);
  const boundaryTime = sortTime(boundary);
  return Number.isFinite(time) && time >= boundaryTime;
}

function isOnOrBefore(dateValue, boundary) {
  if (!boundary) return true;
  const time = sortTime(dateValue);
  const boundaryTime = sortTime(boundary);
  return Number.isFinite(time) && time <= boundaryTime;
}

function sumMinor(rows, key) {
  return rows.reduce((sum, row) => sum + (Number(row?.[key]) || 0), 0);
}

function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function compactJoin(parts, separator = " | ") {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(separator);
}

function compareLedgerRows(a, b) {
  const dayDiff = sortDayTime(a?.date) - sortDayTime(b?.date);
  if (dayDiff !== 0) return dayDiff;

  const typeRank = { opening: 0, invoice: 1, payment: 2 };
  const rankDiff = (typeRank[a?.kind] ?? 9) - (typeRank[b?.kind] ?? 9);
  if (rankDiff !== 0) return rankDiff;

  const timeDiff = sortTime(a?.date) - sortTime(b?.date);
  if (timeDiff !== 0) return timeDiff;

  const createdDiff = sortTime(a?.createdAt) - sortTime(b?.createdAt);
  if (createdDiff !== 0) return createdDiff;

  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function compareOutstandingInvoices(a, b) {
  const dueDiff = sortTime(a?.dueDate) - sortTime(b?.dueDate);
  if (dueDiff !== 0) return dueDiff;

  const invoiceDiff = sortTime(a?.invoiceDate) - sortTime(b?.invoiceDate);
  if (invoiceDiff !== 0) return invoiceDiff;

  const createdDiff = sortTime(a?.createdAt) - sortTime(b?.createdAt);
  if (createdDiff !== 0) return createdDiff;

  return String(a?._id || "").localeCompare(String(b?._id || ""));
}

function getCurrencyMeta(invoices = [], receipts = []) {
  const source =
    invoices.find((invoice) => invoice?.currency) ||
    receipts.find((receipt) => receipt?.currency) ||
    {};

  return {
    currency: source?.currency || "AED",
    minorUnitFactor: source?.minorUnitFactor || 100,
  };
}

function buildInvoiceTransactionRows(invoices = []) {
  return invoices
    .map((invoice) => {
      const invoiceId = getId(invoice);
      const date = resolveInvoiceDate(invoice);
      const amountMinor = getAmountMinor(invoice?.amountMinor);

      if (!invoiceId || !date || amountMinor <= 0) return null;

      return {
        id: `invoice:${invoiceId}`,
        kind: "invoice",
        type: "Invoice",
        date,
        createdAt: toDate(invoice?.createdAt),
        reference: invoice?.invoiceNumber || invoiceId,
        details: "Invoice issued",
        debitMinor: amountMinor,
        creditMinor: 0,
        invoiceId,
        dueDate: invoice?.dueDate,
        currency: invoice?.currency,
        minorUnitFactor: invoice?.minorUnitFactor,
      };
    })
    .filter(Boolean);
}

function buildInvoiceLookup(invoices = []) {
  const map = new Map();
  for (const invoice of invoices) {
    const id = getId(invoice);
    if (id) map.set(id, invoice);
  }
  return map;
}

function buildReceiptLookup(receipts = []) {
  const map = new Map();
  for (const receipt of receipts) {
    const id = getId(receipt);
    if (id) map.set(id, receipt);
  }
  return map;
}

function getReceiptReference(receipt) {
  const id = getId(receipt);
  return receipt?.reference || (id ? `Receipt ${id.slice(-6).toUpperCase()}` : "Receipt");
}

function getPaymentReference(payment) {
  const id = getId(payment);
  return payment?.reference || (id ? `Payment ${id.slice(-6).toUpperCase()}` : "Payment");
}

function buildPaymentDetails(payment, invoiceLookup) {
  const invoiceId = getId(payment?.invoice);
  const invoice = invoiceLookup.get(invoiceId);
  const invoiceLabel = invoice?.invoiceNumber || invoiceId;

  return compactJoin([
    invoiceLabel ? `Payment for ${invoiceLabel}` : "Payment received",
    payment?.paymentMethod,
    payment?.receivedBy ? `received by ${payment.receivedBy}` : "",
  ]);
}

function buildReceiptPaymentRows(payments = [], receiptLookup, invoiceLookup) {
  const groups = new Map();

  for (const payment of payments) {
    const receiptId = getId(payment?.receipt);
    const invoiceId = getId(payment?.invoice);
    if (!receiptId || !invoiceLookup.has(invoiceId)) continue;

    const amountMinor = getAmountMinor(payment?.amountMinor);
    if (amountMinor <= 0) continue;

    const receipt =
      receiptLookup.get(receiptId) || {
        _id: receiptId,
        reference: payment?.reference,
        paymentMethod: payment?.paymentMethod,
        receivedBy: payment?.receivedBy,
      };
    const receiptDate = resolvePaymentDate(receipt);
    const paymentDate = resolvePaymentDate(payment);
    const existing = groups.get(receiptId) || {
      id: `receipt:${receiptId}`,
      kind: "payment",
      type: "Payment",
      sourceType: "receipt",
      date: receiptDate || paymentDate,
      createdAt: toDate(receipt?.createdAt) || toDate(payment?.createdAt),
      reference: getReceiptReference(receipt),
      details: "Payment received",
      debitMinor: 0,
      creditMinor: 0,
      allocationCount: 0,
      paymentMethod: receipt?.paymentMethod || payment?.paymentMethod,
      receivedBy: receipt?.receivedBy || payment?.receivedBy,
    };

    existing.creditMinor += amountMinor;
    existing.allocationCount += 1;

    if (!receiptDate && isBefore(paymentDate || payment?.createdAt, existing.date)) {
      existing.date = paymentDate;
      existing.createdAt = toDate(payment?.createdAt);
    }

    groups.set(receiptId, existing);
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    details: compactJoin([
      "Payment received",
      group.paymentMethod,
      group.receivedBy ? `received by ${group.receivedBy}` : "",
      group.allocationCount > 0
        ? `applied to ${pluralize(group.allocationCount, "invoice")}`
        : "",
    ]),
  }));
}

function buildPaymentCreditRows({ payments = [], receipts = [], invoiceLookup }) {
  const receiptLookup = buildReceiptLookup(receipts);
  const receiptRows = buildReceiptPaymentRows(payments, receiptLookup, invoiceLookup);

  const standaloneRows = payments
    .filter((payment) => !getId(payment?.receipt))
    .map((payment) => {
      const paymentId = getId(payment);
      const invoiceId = getId(payment?.invoice);
      const amountMinor = getAmountMinor(payment?.amountMinor);
      const date = resolvePaymentDate(payment);

      if (!paymentId || !invoiceLookup.has(invoiceId) || !date || amountMinor <= 0) {
        return null;
      }

      return {
        id: `payment:${paymentId}`,
        kind: "payment",
        type: "Payment",
        sourceType: "payment",
        date,
        createdAt: toDate(payment?.createdAt),
        reference: getPaymentReference(payment),
        details: buildPaymentDetails(payment, invoiceLookup),
        debitMinor: 0,
        creditMinor: amountMinor,
        invoiceId,
        paymentMethod: payment?.paymentMethod,
        receivedBy: payment?.receivedBy,
      };
    })
    .filter(Boolean);

  return [...receiptRows, ...standaloneRows];
}

function balanceForRows(rows = []) {
  return rows.reduce(
    (balance, row) =>
      balance + (Number(row?.debitMinor) || 0) - (Number(row?.creditMinor) || 0),
    0
  );
}

function buildOutstandingInvoicesAsOf({ invoices = [], payments = [], cutoffDate }) {
  const paidByInvoice = new Map();

  for (const payment of payments) {
    if (!isOnOrBefore(resolvePaymentDate(payment), cutoffDate)) continue;

    const invoiceId = getId(payment?.invoice);
    if (!invoiceId) continue;

    paidByInvoice.set(
      invoiceId,
      (paidByInvoice.get(invoiceId) || 0) + getAmountMinor(payment?.amountMinor)
    );
  }

  return invoices
    .map((invoice) => {
      const invoiceId = getId(invoice);
      const invoiceDate = resolveInvoiceDate(invoice);
      const amountMinor = getAmountMinor(invoice?.amountMinor);

      if (!invoiceId || !invoiceDate || !isOnOrBefore(invoiceDate, cutoffDate)) {
        return null;
      }

      const rawPaidMinor = paidByInvoice.get(invoiceId) || 0;
      const paidByCutoffMinor = Math.min(amountMinor, rawPaidMinor);
      const balanceMinor = Math.max(0, amountMinor - paidByCutoffMinor);

      if (balanceMinor <= 0) return null;

      return {
        ...invoice,
        _id: invoiceId,
        invoiceDate,
        amountMinor,
        paidByCutoffMinor,
        balanceAsOfCutoffMinor: balanceMinor,
        statementStatus: paidByCutoffMinor > 0 ? "Partially paid" : "Unpaid",
      };
    })
    .filter(Boolean)
    .sort(compareOutstandingInvoices);
}

function buildStatementOfAccountLedger({
  invoices = [],
  payments = [],
  receipts = [],
  fromDate = null,
  cutoffDate = null,
  generatedAt = new Date(),
}) {
  const generated = toDate(generatedAt) || new Date();
  const cutoff = toDate(cutoffDate) || generated;
  const start = toDate(fromDate);
  const { currency, minorUnitFactor } = getCurrencyMeta(invoices, receipts);

  const invoiceLookup = buildInvoiceLookup(invoices);
  const invoiceRows = buildInvoiceTransactionRows(invoices);
  const paymentRows = buildPaymentCreditRows({
    payments,
    receipts,
    invoiceLookup,
  });
  const allRows = [...invoiceRows, ...paymentRows].filter((row) => row?.date);

  const openingRows = start
    ? allRows.filter((row) => isBefore(row.date, start))
    : [];
  const openingBalanceMinor = start ? balanceForRows(openingRows) : 0;

  const activityRowsRaw = allRows
    .filter((row) => isOnOrAfter(row.date, start) && isOnOrBefore(row.date, cutoff))
    .sort(compareLedgerRows);

  let runningBalanceMinor = openingBalanceMinor;
  const activityRows = activityRowsRaw.map((row) => {
    runningBalanceMinor += (Number(row.debitMinor) || 0) - (Number(row.creditMinor) || 0);
    return {
      ...row,
      balanceMinor: runningBalanceMinor,
    };
  });

  const periodInvoicedMinor = sumMinor(activityRows, "debitMinor");
  const periodPaymentsMinor = sumMinor(activityRows, "creditMinor");
  const closingBalanceMinor =
    openingBalanceMinor + periodInvoicedMinor - periodPaymentsMinor;

  const currentRows = allRows.filter((row) => isOnOrBefore(row.date, generated));
  const currentBalanceTodayMinor = balanceForRows(currentRows);

  const outstandingInvoices = buildOutstandingInvoicesAsOf({
    invoices,
    payments,
    cutoffDate: cutoff,
  });
  const currentOutstandingInvoices = buildOutstandingInvoicesAsOf({
    invoices,
    payments,
    cutoffDate: generated,
  });

  const firstTransaction = allRows
    .filter((row) => isOnOrBefore(row.date, cutoff))
    .sort(compareLedgerRows)[0];

  const isHistoricalCutoff = cutoff.getTime() < startOfDubaiDay(generated).getTime();

  return {
    fromDate: start,
    cutoffDate: cutoff,
    generatedAt: generated,
    hasDateRange: Boolean(start),
    isHistoricalCutoff,
    firstTransactionDate: firstTransaction?.date || null,
    activityRows,
    outstandingInvoices,
    summary: {
      openingBalanceMinor,
      periodInvoicedMinor,
      periodPaymentsMinor,
      closingBalanceMinor,
      currentBalanceTodayMinor,
      activityCount: activityRows.length,
      invoiceActivityCount: activityRows.filter((row) => row.kind === "invoice").length,
      paymentActivityCount: activityRows.filter((row) => row.kind === "payment").length,
      outstandingCount: outstandingInvoices.length,
      currentOutstandingCount: currentOutstandingInvoices.length,
      currency,
      minorUnitFactor,
    },
  };
}

export { buildStatementOfAccountLedger };
