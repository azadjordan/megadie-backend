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

const STATEMENT_TIME_ZONE = "Asia/Dubai";

const formatDate = (value) => {
  if (!value) return "--";
  try {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      timeZone: STATEMENT_TIME_ZONE,
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
      timeZone: STATEMENT_TIME_ZONE,
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
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
};

const moneyOrBlank = (amountMinor, currency, factor) => {
  const amount = Number(amountMinor) || 0;
  return amount > 0 ? formatMoney(amount, currency, factor) : "";
};

const formatCount = (value) => {
  const count = Number(value) || 0;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(count);
};

const renderSummaryCard = ({ label, value, note, featured = false }) => `
  <div class="summary-card${featured ? " summary-card--featured" : ""}">
    <div class="summary-label">${safeText(label)}</div>
    <div class="summary-value">${safeText(value)}</div>
    ${note ? `<div class="summary-note">${safeText(note)}</div>` : ""}
  </div>
`;

const getActivityTypeClass = (kind) =>
  kind === "payment" ? "type type--payment" : "type type--invoice";

const renderOpeningBalanceRow = ({ statement, currency, factor }) => {
  if (!statement?.hasDateRange) return "";

  return `
    <tr class="opening-row">
      <td class="muted">${safeText(formatDate(statement.fromDate))}</td>
      <td><span class="type type--opening">Opening</span></td>
      <td>Balance brought forward</td>
      <td class="muted">Balance before selected period</td>
      <td class="amount"></td>
      <td class="amount"></td>
      <td class="amount amount--balance">${safeText(
        formatMoney(statement.summary?.openingBalanceMinor || 0, currency, factor)
      )}</td>
    </tr>
  `;
};

const renderActivityRows = ({ statement, currency, factor }) => {
  const rows = Array.isArray(statement?.activityRows)
    ? statement.activityRows
    : [];

  if (rows.length === 0 && !statement?.hasDateRange) {
    return `
      <tr>
        <td colspan="7" class="empty">No invoices or payments were recorded by this date.</td>
      </tr>
    `;
  }

  const openingRow = renderOpeningBalanceRow({ statement, currency, factor });
  const activityHtml =
    rows.length === 0
      ? `
        <tr>
          <td colspan="7" class="empty">No invoices or payments were recorded during this period.</td>
        </tr>
      `
      : rows
          .map(
            (row) => `
              <tr>
                <td class="muted">${safeText(formatDate(row.date))}</td>
                <td><span class="${getActivityTypeClass(row.kind)}">${safeText(
                  row.type
                )}</span></td>
                <td class="reference">${safeText(row.reference)}</td>
                <td class="details">${safeText(row.details)}</td>
                <td class="amount">${safeText(
                  moneyOrBlank(row.debitMinor, currency, factor),
                  ""
                )}</td>
                <td class="amount">${safeText(
                  moneyOrBlank(row.creditMinor, currency, factor),
                  ""
                )}</td>
                <td class="amount amount--balance">${safeText(
                  formatMoney(row.balanceMinor, currency, factor)
                )}</td>
              </tr>
            `
          )
          .join("");

  return `${openingRow}${activityHtml}`;
};

const renderActivityTable = ({ statement, currency, factor }) => `
  <section class="section">
    <div class="section-head">
      <div class="section-title">Account Activity</div>
      <div class="section-rule"></div>
    </div>
    <table>
      <colgroup>
        <col style="width:12%" />
        <col style="width:10%" />
        <col style="width:17%" />
        <col style="width:25%" />
        <col style="width:12%" />
        <col style="width:12%" />
        <col style="width:12%" />
      </colgroup>
      <thead>
        <tr>
          <th>Date</th>
          <th>Type</th>
          <th>Reference</th>
          <th>Details</th>
          <th style="text-align:right;">Debit</th>
          <th style="text-align:right;">Credit</th>
          <th style="text-align:right;">Balance</th>
        </tr>
      </thead>
      <tbody>
        ${renderActivityRows({ statement, currency, factor })}
      </tbody>
    </table>
  </section>
`;

const renderOutstandingRows = ({ rows, currency, factor }) => {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return `
      <tr>
        <td colspan="7" class="empty">No outstanding invoices as of this statement date.</td>
      </tr>
    `;
  }

  return list
    .map(
      (invoice) => `
        <tr>
          <td class="reference">${safeText(invoice.invoiceNumber || invoice._id)}</td>
          <td class="muted">${safeText(formatDate(invoice.invoiceDate || invoice.createdAt))}</td>
          <td class="muted">${safeText(formatDate(invoice.dueDate))}</td>
          <td class="amount">${safeText(
            formatMoney(invoice.amountMinor, currency, factor)
          )}</td>
          <td class="amount">${safeText(
            formatMoney(invoice.paidByCutoffMinor, currency, factor)
          )}</td>
          <td class="amount amount--balance">${safeText(
            formatMoney(invoice.balanceAsOfCutoffMinor, currency, factor)
          )}</td>
          <td><span class="status">${safeText(invoice.statementStatus)}</span></td>
        </tr>
      `
    )
    .join("");
};

const renderOutstandingTable = ({ statement, currency, factor, cutoffDisplay }) => `
  <section class="section">
    <div class="section-head">
      <div class="section-title">Outstanding Invoices as of ${safeText(
        cutoffDisplay
      )}</div>
      <div class="section-rule"></div>
    </div>
    <table>
      <colgroup>
        <col style="width:18%" />
        <col style="width:13%" />
        <col style="width:13%" />
        <col style="width:14%" />
        <col style="width:14%" />
        <col style="width:15%" />
        <col style="width:13%" />
      </colgroup>
      <thead>
        <tr>
          <th>Invoice #</th>
          <th>Invoice Date</th>
          <th>Due Date</th>
          <th style="text-align:right;">Amount</th>
          <th style="text-align:right;">Paid by Cutoff</th>
          <th style="text-align:right;">Balance</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${renderOutstandingRows({
          rows: statement.outstandingInvoices,
          currency,
          factor,
        })}
      </tbody>
    </table>
  </section>
`;

const getPeriodDisplay = (statement) => {
  const fromDisplay = statement?.fromDate ? formatDate(statement.fromDate) : "";
  const cutoffDisplay = formatDate(statement?.cutoffDate);

  if (statement?.hasDateRange) {
    return `${fromDisplay} to ${cutoffDisplay}`;
  }

  const firstDisplay = statement?.firstTransactionDate
    ? formatDate(statement.firstTransactionDate)
    : "account opening";
  return `${firstDisplay} to ${cutoffDisplay}`;
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

const renderStatementOfAccountHtml = ({ client, statement }) => {
  const safeStatement = statement || {};
  const summary = safeStatement.summary || {};
  const currency = summary.currency || "AED";
  const factor = summary.minorUnitFactor || 100;
  const generatedLabel = formatDateTime(safeStatement.generatedAt || new Date());
  const cutoffDisplay = formatDate(safeStatement.cutoffDate || new Date());
  const periodDisplay = getPeriodDisplay(safeStatement);
  const openingNote = safeStatement.hasDateRange
    ? `Before ${formatDate(safeStatement.fromDate)}`
    : "Start of account";
  const summaryCards = [
    renderSummaryCard({
      label: "Opening Balance",
      value: formatMoney(summary.openingBalanceMinor || 0, currency, factor),
      note: openingNote,
    }),
    renderSummaryCard({
      label: "Invoiced",
      value: formatMoney(summary.periodInvoicedMinor || 0, currency, factor),
      note: `${formatCount(summary.invoiceActivityCount)} invoice rows`,
    }),
    renderSummaryCard({
      label: "Payments Received",
      value: formatMoney(summary.periodPaymentsMinor || 0, currency, factor),
      note: `${formatCount(summary.paymentActivityCount)} payment rows`,
    }),
    renderSummaryCard({
      label: "Closing Balance",
      value: formatMoney(summary.closingBalanceMinor || 0, currency, factor),
      note: `As of ${cutoffDisplay}`,
      featured: true,
    }),
    safeStatement.isHistoricalCutoff
      ? renderSummaryCard({
          label: "Current Balance Today",
          value: formatMoney(summary.currentBalanceTodayMinor || 0, currency, factor),
          note: "Shown because this statement ends before today",
          featured: true,
        })
      : "",
  ].join("");

  const currentBalanceNote = safeStatement.isHistoricalCutoff
    ? " Current Balance Today is shown separately because the statement cutoff is earlier than today."
    : "";

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
            --blue: #1D4ED8;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 0;
            color: var(--text);
            font-family: "Helvetica", Arial, sans-serif;
            font-size: 12px;
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
            letter-spacing: 0;
          }
          .brand-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
          .title-block { text-align: right; }
          .doc-title { font-size: 19px; font-weight: 700; }
          .meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
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
          .summary--with-current {
            grid-template-columns: repeat(5, minmax(0, 1fr));
          }
          .summary-card {
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 9px;
            background: #ffffff;
            min-height: 68px;
          }
          .summary-card--featured {
            border-color: var(--violet);
            background: var(--violet-soft);
          }
          .summary-label {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--muted);
          }
          .summary-value {
            margin-top: 4px;
            font-size: 12px;
            font-weight: 700;
            color: var(--text);
          }
          .summary-note {
            margin-top: 3px;
            font-size: 9px;
            color: var(--muted);
            line-height: 1.35;
          }
          .section { margin-top: 13px; }
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
            letter-spacing: 0.5px;
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
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--muted);
          }
          .client-value { margin-top: 4px; font-size: 11px; }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 8px;
            table-layout: fixed;
          }
          thead { display: table-header-group; }
          thead th {
            background: var(--violet-soft);
            color: var(--muted);
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            padding: 7px 5px;
            text-align: left;
            border-top: 1px solid var(--border);
            border-bottom: 1px solid var(--border);
          }
          tbody td {
            padding: 7px 5px;
            border-bottom: 1px solid var(--border);
            vertical-align: top;
            font-size: 10px;
            overflow-wrap: anywhere;
          }
          tbody tr:nth-child(even) { background: var(--row); }
          tbody tr { page-break-inside: avoid; }
          .muted { color: var(--muted); }
          .amount {
            text-align: right;
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
          }
          .amount--balance { font-weight: 700; }
          .reference { font-weight: 700; }
          .details { color: var(--muted); line-height: 1.35; }
          .type,
          .status {
            display: inline-block;
            font-weight: 700;
            font-size: 9px;
          }
          .type--invoice { color: var(--blue); }
          .type--payment { color: var(--green); }
          .type--opening { color: var(--muted); }
          .opening-row {
            background: #ffffff !important;
          }
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
            font-size: 10px;
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
            <div class="meta">Period: ${safeText(periodDisplay)}</div>
          </div>
        </header>
        <div class="accent"></div>

        <div class="summary${
          safeStatement.isHistoricalCutoff ? " summary--with-current" : ""
        }">
          ${summaryCards}
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

        ${renderActivityTable({ statement: safeStatement, currency, factor })}

        ${renderOutstandingTable({
          statement: safeStatement,
          currency,
          factor,
          cutoffDisplay,
        })}

        <div class="note">
          This statement is calculated from issued invoices and recorded payments.
          Customer receipt payments are shown once in Account Activity, even when
          they were allocated across multiple invoices. The outstanding invoice
          table explains the closing balance as of ${safeText(cutoffDisplay)}.${safeText(
            currentBalanceNote,
            ""
          )}
        </div>
      </body>
    </html>
  `;
};

export { renderStatementOfAccountHtml, statementOfAccountFooterTemplate };
