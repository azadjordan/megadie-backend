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

const asNumber = (v) => {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
};

const money = (n) => asNumber(n).toFixed(2);

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

const footerYear = new Date().getFullYear();

const quoteFooterTemplate = `
  <div style="width:100%; font-size:11px; color:#6B7280; padding:0 16mm;">
    <div style="border-top:1px solid #E5E7EB; padding-top:6px; display:flex; justify-content:space-between; align-items:center;">
      <div>&copy; ${footerYear} <span style="color:#4B0082; font-weight:700;">Megadie</span> | Read T&amp;C @ www.megadie.com</div>
      <div>Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
    </div>
  </div>
`;

const renderQuoteHtml = ({ quote }) => {
  const items = Array.isArray(quote?.requestedItems) ? quote.requestedItems : [];
  const quoteNo = quote?.quoteNumber || quote?._id || "--";
  const rowsHtml =
    items.length === 0
      ? `
        <tr>
          <td colspan="3" class="empty">No items on this quote.</td>
        </tr>
      `
      : items
          .map((item) => {
            const qty = asNumber(item?.qty);
            const unit = asNumber(item?.unitPrice);
            const lineTotal = Math.max(0, unit * qty);
            const productLabel =
              item?.productName ||
              item?.sku ||
              item?.product?.sku ||
              item?.product?.name ||
              item?.product?.code ||
              "Unnamed";
            return `
              <tr>
                <td class="col-product">${safeText(productLabel)}</td>
                <td class="col-qty">${safeText(qty)}</td>
                <td class="col-total">${safeText(money(lineTotal))}</td>
              </tr>
            `;
          })
          .join("");

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Quote</title>
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
          .doc { text-align: right; }
          .doc-title { font-size: 19px; font-weight: 700; }
          .doc-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
          .accent {
            height: 3px;
            background: var(--violet);
            border-radius: 2px;
            margin: 8px 0 12px;
          }
          .info-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
          }
          .info-card {
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 10px;
            background: #ffffff;
          }
          .info-title {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--muted);
            margin-bottom: 6px;
          }
          .info-item { display: flex; gap: 8px; margin-bottom: 4px; }
          .info-label {
            width: 72px;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--muted);
          }
          .info-value { font-size: 12px; color: var(--text); }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 14px;
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
          .col-product { width: 55%; }
          .col-qty { width: 15%; text-align: right; }
          .col-total { width: 30%; text-align: right; }
          .empty { text-align: center; color: var(--muted); padding: 12px 6px; }
          .totals {
            margin-top: 12px;
            margin-left: auto;
            width: 42%;
            border-top: 1px solid var(--border);
            padding-top: 8px;
          }
          .totals-row {
            display: flex;
            justify-content: space-between;
            gap: 10px;
            font-size: 12px;
            margin-bottom: 5px;
          }
          .totals-row.total { font-weight: 700; color: var(--violet); }
        </style>
      </head>
      <body>
        <header class="header">
          <div>
            <div class="brand">Megadie</div>
            <div class="brand-sub">Megadie.com</div>
          </div>
          <div class="doc">
            <div class="doc-title">Quote</div>
            <div class="doc-meta">Quote #: ${safeText(quoteNo)}</div>
            <div class="doc-meta">Date: ${safeText(formatDate(quote?.createdAt))}</div>
          </div>
        </header>
        <div class="accent"></div>

        <div class="info-grid">
          <div class="info-card">
            <div class="info-title">Client</div>
            <div class="info-item">
              <div class="info-label">Name</div>
              <div class="info-value">${safeText(quote?.user?.name)}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Email</div>
              <div class="info-value">${safeText(quote?.user?.email)}</div>
            </div>
          </div>
          <div class="info-card">
            <div class="info-title">Details</div>
            <div class="info-item">
              <div class="info-label">Status</div>
              <div class="info-value">${safeText(quote?.status)}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Quote #</div>
              <div class="info-value">${safeText(quoteNo)}</div>
            </div>
          </div>
        </div>

        <table>
          <colgroup>
            <col style="width:55%" />
            <col style="width:15%" />
            <col style="width:30%" />
          </colgroup>
          <thead>
            <tr>
              <th>Product</th>
              <th style="text-align:right;">Qty</th>
              <th style="text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>

        <div class="totals">
          <div class="totals-row">
            <span>Delivery charge</span>
            <span>${safeText(money(quote?.deliveryCharge))}</span>
          </div>
          <div class="totals-row">
            <span>Extra fee</span>
            <span>${safeText(money(quote?.extraFee))}</span>
          </div>
          <div class="totals-row total">
            <span>Total price</span>
            <span>${safeText(money(quote?.totalPrice))}</span>
          </div>
        </div>
      </body>
    </html>
  `;
};

export { renderQuoteHtml, quoteFooterTemplate };
