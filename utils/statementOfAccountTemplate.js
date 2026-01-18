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

const isOverdue = (inv) => {
  if (!inv?.dueDate) return false;
  const due = Date.parse(inv.dueDate);
  if (!Number.isFinite(due)) return false;
  return due < Date.now();
};

const formatStatus = (inv, overdue) => {
  if (overdue) {
    return inv?.paymentStatus === "PartiallyPaid"
      ? "Overdue (Partial)"
      : "Overdue";
  }
  return inv?.paymentStatus === "PartiallyPaid" ? "Partially paid" : "Unpaid";
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
  summary,
  generatedAt,
}) => {
  const list = Array.isArray(invoices) ? invoices : [];
  const currency = summary?.currency || "AED";
  const factor = summary?.minorUnitFactor || 100;
  const unpaidTotal = summary?.totalDueMinor ?? 0;
  const overdueTotal = summary?.overdueTotalMinor ?? 0;
  const asOf = formatDateTime(generatedAt || new Date());
  const openCount = list.length;
  const overdueCount = list.reduce(
    (sum, inv) => (isOverdue(inv) ? sum + 1 : sum),
    0
  );
  const openLabel =
    overdueCount > 0 ? `${openCount} (${overdueCount} overdue)` : `${openCount}`;

  const rowsHtml =
    list.length === 0
      ? `
        <tr>
          <td colspan="5" class="empty">No unpaid invoices at this time.</td>
        </tr>
      `
      : list
          .map((inv) => {
            const overdue = isOverdue(inv);
            const status = formatStatus(inv, overdue);
            const statusClass = overdue
              ? "status status--overdue"
              : inv?.paymentStatus === "PartiallyPaid"
              ? "status status--partial"
              : "status status--unpaid";
            return `
              <tr>
                <td class="col-invoice">${safeText(inv.invoiceNumber || inv._id)}</td>
                <td class="col-issued muted">${safeText(formatDate(inv.createdAt))}</td>
                <td class="col-due muted">${safeText(formatDate(inv.dueDate))}</td>
                <td class="col-status ${statusClass}">${safeText(status)}</td>
                <td class="col-balance">${safeText(
                  formatMoney(inv.balanceDueMinor, currency, factor)
                )}</td>
              </tr>
            `;
          })
          .join("");

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
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 8px;
          }
          .summary-card {
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 10px;
            background: var(--violet-soft);
          }
          .summary-label {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--muted);
          }
          .summary-value {
            margin-top: 4px;
            font-size: 13px;
            font-weight: 700;
            color: var(--text);
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
            font-size: 11px;
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
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            padding: 8px 6px;
            text-align: left;
            border-top: 1px solid var(--border);
            border-bottom: 1px solid var(--border);
          }
          tbody td {
            padding: 8px 6px;
            border-bottom: 1px solid var(--border);
            vertical-align: top;
            font-size: 12px;
          }
          tbody tr:nth-child(even) { background: var(--row); }
          tbody tr { page-break-inside: avoid; }
          .muted { color: var(--muted); }
          .col-balance { text-align: right; font-variant-numeric: tabular-nums; }
          .status { font-weight: 600; }
          .status--overdue { color: #B91C1C; }
          .status--partial { color: #B45309; }
          .status--unpaid { color: var(--text); }
          .empty {
            text-align: center;
            color: var(--muted);
            padding: 12px 6px;
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
            <div class="meta">As of ${safeText(asOf)}</div>
          </div>
        </header>
        <div class="accent"></div>

        <div class="summary">
          <div class="summary-card">
            <div class="summary-label">Unpaid balance</div>
            <div class="summary-value">${safeText(
              formatMoney(unpaidTotal, currency, factor)
            )}</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">Overdue balance</div>
            <div class="summary-value">${safeText(
              formatMoney(overdueTotal, currency, factor)
            )}</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">Open invoices</div>
            <div class="summary-value">${safeText(openLabel)}</div>
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
            <div class="section-title">Open invoices</div>
            <div class="section-rule"></div>
          </div>
          <table>
            <colgroup>
              <col style="width:28%" />
              <col style="width:16%" />
              <col style="width:16%" />
              <col style="width:18%" />
              <col style="width:22%" />
            </colgroup>
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Status</th>
                <th style="text-align:right;">Balance</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </section>
      </body>
    </html>
  `;
};

export { renderStatementOfAccountHtml, statementOfAccountFooterTemplate };
