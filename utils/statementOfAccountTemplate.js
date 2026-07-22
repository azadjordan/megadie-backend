const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const safeText = (value, fallback = "--") => {
  if (value === 0) return "0";
  if (value === null || value === undefined || value === "") return fallback;
  return escapeHtml(String(value));
};

const formatDate = (value) => {
  if (!value) return "--";
  try {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
  } catch {
    return safeText(value);
  }
};

const formatDateTime = (value) => {
  if (!value) return "--";
  try {
    return new Date(value).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return safeText(value);
  }
};

const formatMoney = (amountMinor, currency = "AED", factor = 100) => {
  const safe = Number(amountMinor);
  if (!Number.isFinite(safe)) return "--";
  const denom = Number.isFinite(Number(factor)) && factor > 0 ? factor : 100;
  const major = safe / denom;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
};

const getBalanceMinor = (invoice) =>
  Number(invoice?.balanceMinor ?? invoice?.balanceDueMinor ?? 0) || 0;

const getRecordedPaidMinor = (invoice) =>
  Number(invoice?.recordedPaidMinor ?? invoice?.paidTotalMinor ?? 0) || 0;

const isOverdue = (invoice, referenceDate) => {
  const balance = getBalanceMinor(invoice);
  if (balance <= 0 || !invoice?.dueDate) return false;
  const due = Date.parse(invoice.dueDate);
  const reference = referenceDate ? Date.parse(referenceDate) : Date.now();
  if (!Number.isFinite(due) || !Number.isFinite(reference)) return false;
  return due < reference;
};

const formatStatus = (invoice, overdue) => {
  const balance = getBalanceMinor(invoice);
  const recordedPaid = getRecordedPaidMinor(invoice);
  if (balance <= 0) return "Paid";
  if (overdue && recordedPaid > 0) return "Overdue (Partial)";
  if (overdue) return "Overdue";
  if (recordedPaid > 0) return "Partially paid";
  return "Unpaid";
};

const statusClassFor = (invoice, overdue) => {
  const balance = getBalanceMinor(invoice);
  const recordedPaid = getRecordedPaidMinor(invoice);
  if (balance <= 0) return "status status--paid";
  if (overdue) return "status status--overdue";
  if (recordedPaid > 0) return "status status--partial";
  return "status status--unpaid";
};

const renderInvoiceRows = ({
  rows,
  emptyMessage,
  currency,
  factor,
  overdueReferenceDate,
}) => {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return `
      <tr>
        <td colspan="7" class="empty">${safeText(emptyMessage)}</td>
      </tr>
    `;
  }

  return list
    .map((invoice) => {
      const overdue = isOverdue(invoice, overdueReferenceDate);
      const status = formatStatus(invoice, overdue);
      const statusClass = statusClassFor(invoice, overdue);

      return `
        <tr>
          <td class="col-invoice">${safeText(
            invoice.invoiceNumber || invoice._id
          )}</td>
          <td class="col-issued muted">${safeText(
            formatDate(invoice.invoiceDate || invoice.createdAt)
          )}</td>
          <td class="col-due muted">${safeText(formatDate(invoice.dueDate))}</td>
          <td class="col-amount">${safeText(
            formatMoney(invoice.amountMinor, currency, factor)
          )}</td>
          <td class="col-paid">${safeText(
            formatMoney(getRecordedPaidMinor(invoice), currency, factor)
          )}</td>
          <td class="col-balance">${safeText(
            formatMoney(getBalanceMinor(invoice), currency, factor)
          )}</td>
          <td class="col-status ${statusClass}">${safeText(status)}</td>
        </tr>
      `;
    })
    .join("");
};

const footerYear = new Date().getFullYear();

const statementOfAccountFooterTemplate = `
  <div style="width:100%; font-size:11px; color:#6B7280; padding:0 16mm;">
    <div style="border-top:1px solid #E5E7EB; padding-top:6px; display:flex; justify-content:space-between; align-items:center;">
      <div>&copy; ${footerYear} <span style="color:#4B0082; font-weight:700;">Megadie</span> | Read T&amp;C @ www.megadie.com</div>
      <div>Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
    </div>
  </div>
`;

const renderStatementOfAccountHtml = ({
  client,
  invoices,
  periodInvoices,
  outstandingInvoices,
  summary,
  generatedAt,
  fromDateLabel,
  cutoffDateLabel,
}) => {
  const periodList = Array.isArray(periodInvoices)
    ? periodInvoices
    : Array.isArray(invoices)
    ? invoices
    : [];
  const outstandingList = Array.isArray(outstandingInvoices)
    ? outstandingInvoices
    : [];
  const currency = summary?.currency || "AED";
  const factor = summary?.minorUnitFactor || 100;
  const openingBalance = summary?.openingBalanceMinor ?? 0;
  const periodInvoiced = summary?.periodInvoicedMinor ?? 0;
  const recordedPayments = summary?.recordedPaymentsMinor ?? 0;
  const closingBalance = summary?.closingBalanceMinor ?? 0;
  const overdueTotal = summary?.overdueTotalMinor ?? 0;
  const periodInvoiceCount = Number.isFinite(Number(summary?.periodInvoiceCount))
    ? Number(summary.periodInvoiceCount)
    : periodList.length;
  const outstandingCount = Number.isFinite(Number(summary?.outstandingCount))
    ? Number(summary.outstandingCount)
    : outstandingList.length;
  const previousInvoiceCount = Number.isFinite(
    Number(summary?.previousInvoiceCount)
  )
    ? Number(summary.previousInvoiceCount)
    : 0;
  const overdueCount = Number.isFinite(Number(summary?.overdueCount))
    ? Number(summary.overdueCount)
    : 0;
  const generatedLabel = formatDateTime(generatedAt || new Date());
  const hasFromDate = Boolean(fromDateLabel);
  const hasCutoffDate = Boolean(cutoffDateLabel);
  const recordedPaymentsNote = hasFromDate
    ? "For period invoices"
    : "For included invoices";
  const periodLabel = hasFromDate && hasCutoffDate
    ? `${safeText(formatDate(fromDateLabel))} to ${safeText(
        formatDate(cutoffDateLabel)
      )}`
    : hasCutoffDate
    ? `All invoices up to ${safeText(formatDate(cutoffDateLabel))}`
    : "All invoices";
  const outstandingTitle = "Outstanding Invoices";
  const periodTitle = hasFromDate
    ? "Invoices Issued During Period"
    : hasCutoffDate
    ? `Invoices Issued Up To ${safeText(formatDate(cutoffDateLabel))}`
    : "Invoices Issued";
  const overdueReferenceDate = summary?.overdueReferenceDate || cutoffDateLabel;

  const outstandingRowsHtml = renderInvoiceRows({
    rows: outstandingList,
    emptyMessage: "No outstanding invoices in this statement.",
    currency,
    factor,
    overdueReferenceDate,
  });
  const periodRowsHtml = renderInvoiceRows({
    rows: periodList,
    emptyMessage: "No issued invoices match this statement period.",
    currency,
    factor,
    overdueReferenceDate,
  });

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Statement of Account</title>
        <style>
          :root {
            --violet: #4B0082;
            --violet-soft: #F4F1FF;
            --text: #1F2937;
            --muted: #6B7280;
            --border: #E5E7EB;
            --row: #FAFAFC;
            --green: #047857;
            --amber: #B45309;
            --red: #B91C1C;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 0;
            color: var(--text);
            font-family: "Helvetica", Arial, sans-serif;
            font-size: 13px;
            background: #ffffff;
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            gap: 16px;
          }
          .brand {
            font-size: 22px;
            font-weight: 700;
            color: var(--violet);
            letter-spacing: 0.2px;
          }
          .brand-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
          .title-block { text-align: right; }
          .doc-title { font-size: 19px; font-weight: 700; }
          .meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
          .accent {
            height: 3px;
            background: var(--violet);
            border-radius: 2px;
            margin: 8px 0 12px;
          }
          .summary {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 8px;
          }
          .summary-card {
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 10px;
            background: var(--violet-soft);
          }
          .summary-card--closing {
            background: #ffffff;
            border-color: var(--violet);
          }
          .summary-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--muted);
          }
          .summary-value {
            margin-top: 4px;
            font-size: 13px;
            font-weight: 700;
            color: var(--text);
          }
          .summary-note {
            margin-top: 3px;
            font-size: 10px;
            color: var(--muted);
          }
          .section { margin-top: 14px; }
          .section-head {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
          }
          .section-title {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.6px;
          }
          .section-rule {
            flex: 1;
            border-bottom: 1px solid var(--border);
          }
          .client-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 8px 12px;
          }
          .client-item {
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 8px 10px;
            background: #ffffff;
          }
          .client-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--muted);
          }
          .client-value { margin-top: 4px; font-size: 12px; }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
            table-layout: fixed;
          }
          thead { display: table-header-group; }
          thead th {
            background: var(--violet-soft);
            color: var(--muted);
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 8px 6px;
            text-align: left;
            border-top: 1px solid var(--border);
            border-bottom: 1px solid var(--border);
          }
          tbody td {
            padding: 8px 6px;
            border-bottom: 1px solid var(--border);
            vertical-align: top;
            font-size: 11px;
          }
          tbody tr:nth-child(even) { background: var(--row); }
          tbody tr { page-break-inside: avoid; }
          .muted { color: var(--muted); }
          .col-amount,
          .col-paid,
          .col-balance {
            text-align: right;
            font-variant-numeric: tabular-nums;
          }
          .status { font-weight: 600; }
          .status--paid { color: var(--green); }
          .status--overdue { color: var(--red); }
          .status--partial { color: var(--amber); }
          .status--unpaid { color: var(--text); }
          .empty {
            text-align: center;
            color: var(--muted);
            padding: 12px 6px;
          }
          .note {
            margin-top: 14px;
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 9px 10px;
            color: var(--muted);
            font-size: 11px;
            line-height: 1.5;
            background: #ffffff;
          }
        </style>
      </head>
      <body>
        <header class="header">
          <div>
            <div class="brand">Megadie</div>
            <div class="brand-sub">Megadie.com</div>
          </div>
          <div class="title-block">
            <div class="doc-title">Statement of Account</div>
            <div class="meta">Generated ${safeText(generatedLabel)}</div>
            <div class="meta">Period: ${periodLabel}</div>
          </div>
        </header>
        <div class="accent"></div>

        <div class="summary">
          <div class="summary-card">
            <div class="summary-label">Opening Balance</div>
            <div class="summary-value">${safeText(
              formatMoney(openingBalance, currency, factor)
            )}</div>
            <div class="summary-note">${safeText(previousInvoiceCount)} previous balance${
              previousInvoiceCount === 1 ? "" : "s"
            }</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">Period Invoiced</div>
            <div class="summary-value">${safeText(
              formatMoney(periodInvoiced, currency, factor)
            )}</div>
            <div class="summary-note">${safeText(periodInvoiceCount)} invoice${
              periodInvoiceCount === 1 ? "" : "s"
            }</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">Recorded Payments</div>
            <div class="summary-value">${safeText(
              formatMoney(recordedPayments, currency, factor)
            )}</div>
            <div class="summary-note">${safeText(recordedPaymentsNote)}</div>
          </div>
          <div class="summary-card summary-card--closing">
            <div class="summary-label">Closing Balance</div>
            <div class="summary-value">${safeText(
              formatMoney(closingBalance, currency, factor)
            )}</div>
            <div class="summary-note">${safeText(outstandingCount)} outstanding${
              overdueCount > 0
                ? `, ${safeText(overdueCount)} overdue`
                : ""
            }</div>
          </div>
        </div>

        <section class="section">
          <div class="section-head">
            <div class="section-title">Client</div>
            <div class="section-rule"></div>
          </div>
          <div class="client-grid">
            <div class="client-item">
              <div class="client-label">Name</div>
              <div class="client-value">${safeText(client?.name || "--")}</div>
            </div>
            <div class="client-item">
              <div class="client-label">Email</div>
              <div class="client-value">${safeText(client?.email || "--")}</div>
            </div>
            <div class="client-item">
              <div class="client-label">Phone</div>
              <div class="client-value">${safeText(client?.phoneNumber || "--")}</div>
            </div>
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <div class="section-title">${outstandingTitle}</div>
            <div class="section-rule"></div>
          </div>
          <table>
            <colgroup>
              <col style="width:18%" />
              <col style="width:13%" />
              <col style="width:13%" />
              <col style="width:14%" />
              <col style="width:15%" />
              <col style="width:14%" />
              <col style="width:13%" />
            </colgroup>
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Invoice Date</th>
                <th>Due Date</th>
                <th style="text-align:right;">Amount</th>
                <th style="text-align:right;">Recorded Paid</th>
                <th style="text-align:right;">Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${outstandingRowsHtml}
            </tbody>
          </table>
        </section>

        <section class="section">
          <div class="section-head">
            <div class="section-title">${periodTitle}</div>
            <div class="section-rule"></div>
          </div>
          <table>
            <colgroup>
              <col style="width:18%" />
              <col style="width:13%" />
              <col style="width:13%" />
              <col style="width:14%" />
              <col style="width:15%" />
              <col style="width:14%" />
              <col style="width:13%" />
            </colgroup>
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Invoice Date</th>
                <th>Due Date</th>
                <th style="text-align:right;">Amount</th>
                <th style="text-align:right;">Recorded Paid</th>
                <th style="text-align:right;">Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${periodRowsHtml}
            </tbody>
          </table>
        </section>

        <div class="note">
          Payments shown are based on payments recorded in Megadie before this
          statement was generated. The date range controls which invoice dates
          are included. Overpaid invoices, if any, are shown with a zero
          remaining balance.
          ${overdueCount > 0
            ? ` Overdue balance included in closing balance: ${safeText(
                formatMoney(overdueTotal, currency, factor)
              )}.`
            : ""}
        </div>
      </body>
    </html>
  `;
};

export { renderStatementOfAccountHtml, statementOfAccountFooterTemplate };
