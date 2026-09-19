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

const REPORT_TIME_ZONE = "Asia/Dubai";

const formatDate = (value) => {
  if (!value) return "--";
  try {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      timeZone: REPORT_TIME_ZONE,
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
      timeZone: REPORT_TIME_ZONE,
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

const formatCount = (value) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    Number(value) || 0
  );

const getStatusLabel = (invoice) => {
  if (invoice?.paymentStatus === "PartiallyPaid") return "Partially paid";
  return "Unpaid";
};

const renderInvoiceRows = ({ invoices, currency, factor }) => {
  const rows = Array.isArray(invoices) ? invoices : [];
  if (rows.length === 0) {
    return `
      <tr>
        <td colspan="7" class="empty">No outstanding invoices.</td>
      </tr>
    `;
  }

  return rows
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
            formatMoney(invoice.paidTotalMinor || 0, currency, factor)
          )}</td>
          <td class="amount amount--due">${safeText(
            formatMoney(invoice.balanceDueMinor || 0, currency, factor)
          )}</td>
          <td><span class="status">${safeText(getStatusLabel(invoice))}</span></td>
        </tr>
      `
    )
    .join("");
};

const footerYear = new Date().getFullYear();

const outstandingBalanceFooterTemplate = `
  <div style="width:100%; font-size:11px; color:#6B7280; padding:0 16mm;">
    <div style="border-top:1px solid #E5E7EB; padding-top:6px; display:flex; justify-content:space-between; align-items:center;">
      <div>&copy; ${footerYear} <span style="color:#4B0082; font-weight:700;">Megadie</span> | Read T&amp;C @ www.megadie.com</div>
      <div>Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
    </div>
  </div>
`;

const renderOutstandingBalanceHtml = ({
  client,
  invoices,
  summary,
  generatedAt,
}) => {
  const rows = Array.isArray(invoices) ? invoices : [];
  const currency = summary?.currency || "AED";
  const factor = summary?.minorUnitFactor || 100;
  const totalDue = Number(summary?.totalDueMinor) || 0;
  const invoiceCount = Number(summary?.invoiceCount) || rows.length;
  const generatedLabel = formatDateTime(generatedAt || new Date());

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Outstanding Balance Statement</title>
        <style>
          :root {
            --violet: #4B0082;
            --violet-soft: #F4F1FF;
            --text: #1F2937;
            --muted: #6B7280;
            --border: #E5E7EB;
            --row: #FAFAFC;
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
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 8px;
          }
          .summary-card {
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 10px;
            background: #ffffff;
            min-height: 72px;
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
            margin-top: 5px;
            font-size: 15px;
            font-weight: 700;
            color: var(--text);
          }
          .summary-note {
            margin-top: 3px;
            font-size: 10px;
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
          .amount--due,
          .reference {
            font-weight: 700;
          }
          .status {
            display: inline-block;
            font-size: 9px;
            font-weight: 700;
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
            <div class="doc-title">Outstanding Balance Statement</div>
            <div class="meta">Generated ${safeText(generatedLabel)}</div>
            <div class="meta">Current outstanding invoices</div>
          </div>
        </header>
        <div class="accent"></div>

        <div class="summary">
          <div class="summary-card summary-card--featured">
            <div class="summary-label">Current Amount Due</div>
            <div class="summary-value">${safeText(
              formatMoney(totalDue, currency, factor)
            )}</div>
            <div class="summary-note">Total unpaid balance now</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">Outstanding Invoices</div>
            <div class="summary-value">${safeText(formatCount(invoiceCount))}</div>
            <div class="summary-note">Issued invoices not fully paid</div>
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
            <div class="section-title">Invoices to be Paid</div>
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
                <th style="text-align:right;">Paid</th>
                <th style="text-align:right;">Balance Due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${renderInvoiceRows({ invoices: rows, currency, factor })}
            </tbody>
          </table>
        </section>

        <div class="note">
          Please arrange payment for the current amount due listed above.
          Payments already recorded before this document was generated are
          reflected in the Paid and Balance Due columns.
        </div>
      </body>
    </html>
  `;
};

export { renderOutstandingBalanceHtml, outstandingBalanceFooterTemplate };
