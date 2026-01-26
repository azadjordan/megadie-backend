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

const fractionDigitsFromFactor = (factor) => {
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0) return 2;
  if (f === 1) return 0;
  const pow = Math.log10(f);
  return Number.isInteger(pow) ? pow : 2;
};

const minorToMajor = (minor, factor) => {
  const n = asNumber(minor);
  const f = Number(factor);
  const safeFactor = Number.isFinite(f) && f > 0 ? f : 100;
  return n / safeFactor;
};

const money = (n, digits = 2) => asNumber(n).toFixed(digits);

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

const invoiceFooterTemplate = `
  <div style="width:100%; font-size:11px; color:#6B7280; padding:0 16mm;">
    <div style="border-top:1px solid #E5E7EB; padding-top:6px; display:flex; justify-content:space-between; align-items:center;">
      <div>&copy; ${footerYear} <span style="color:#4B0082; font-weight:700;">Megadie</span> | Read T&amp;C @ www.megadie.com</div>
      <div>Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
    </div>
  </div>
`;

const renderInvoiceHtml = ({ invoice, order, company }) => {
  const factor = Number(invoice?.minorUnitFactor);
  const minorUnitFactor = Number.isFinite(factor) && factor > 0 ? factor : 100;
  const fractionDigits = fractionDigitsFromFactor(minorUnitFactor);

  const orderItems = Array.isArray(order?.orderItems)
    ? order.orderItems
    : [];
  const manualItems = Array.isArray(invoice?.invoiceItems)
    ? invoice.invoiceItems
    : [];

  const isManual =
    invoice?.source === "Manual" ||
    (!order && manualItems.length > 0);
  const useOrderItems = !isManual;
  const lineItems = useOrderItems ? orderItems : manualItems;

  const deliveryCharge = useOrderItems ? asNumber(order?.deliveryCharge ?? 0) : 0;
  const extraFee = useOrderItems ? asNumber(order?.extraFee ?? 0) : 0;

  const manualSubtotalMinor = manualItems.reduce((sum, it) => {
    const lineMinor = Number.isFinite(Number(it?.lineTotalMinor))
      ? Number(it.lineTotalMinor)
      : asNumber(it?.unitPriceMinor) * asNumber(it?.qty);
    return sum + Math.max(0, lineMinor);
  }, 0);

  const subtotal = useOrderItems
    ? orderItems.reduce(
        (sum, it) => sum + asNumber(it.unitPrice) * asNumber(it.qty),
        0
      )
    : minorToMajor(manualSubtotalMinor, minorUnitFactor);

  const invoiceAmount = Number.isFinite(Number(invoice?.amountMinor))
    ? minorToMajor(invoice.amountMinor, minorUnitFactor)
    : subtotal + deliveryCharge + extraFee;

  const paymentsArray = Array.isArray(invoice?.payments) ? invoice.payments : [];
  const receivedPaymentsTotal = paymentsArray.reduce((sum, p) => {
    if (p && typeof p.amountMinor === "number") {
      return sum + minorToMajor(p.amountMinor, minorUnitFactor);
    }
    if (p && typeof p.amount === "number") {
      return sum + asNumber(p.amount);
    }
    return sum;
  }, 0);

  const amountPaid = Number.isFinite(Number(invoice?.paidTotalMinor))
    ? minorToMajor(invoice.paidTotalMinor, minorUnitFactor)
    : receivedPaymentsTotal;

  const balanceDue = Number.isFinite(Number(invoice?.balanceDueMinor))
    ? minorToMajor(invoice.balanceDueMinor, minorUnitFactor)
    : Math.max(invoiceAmount - amountPaid, 0);

  const companyName = company?.name || "Megadie";
  const companySite = company?.display || "Megadie.com";
  const detailLabel = useOrderItems ? "Order #" : "Type";
  const detailValue = useOrderItems ? order?.orderNumber : "Manual";
  const itemHeader = useOrderItems ? "Product" : "Item";
  const deliveryRowHtml = useOrderItems
    ? `
          <div class="totals-row">
            <span>Delivery charge</span>
            <span>${safeText(money(deliveryCharge, fractionDigits))}</span>
          </div>
          <div class="totals-row">
            <span>Extra fee</span>
            <span>${safeText(money(extraFee, fractionDigits))}</span>
          </div>
        `
    : "";

  const rowsHtml =
    lineItems.length === 0
      ? `
        <tr>
          <td colspan="3" class="empty">No items on this invoice.</td>
        </tr>
      `
      : lineItems
          .map((item) => {
            const qty = asNumber(item?.qty);
            const lineTotal = useOrderItems
              ? asNumber(item?.unitPrice) * qty
              : minorToMajor(
                  Number.isFinite(Number(item?.lineTotalMinor))
                    ? Number(item.lineTotalMinor)
                    : asNumber(item?.unitPriceMinor) * qty,
                  minorUnitFactor
                );
            const productLabel = useOrderItems
              ? item?.productName ||
                item?.product?.name ||
                item?.sku ||
                "Unnamed"
              : item?.description || "Item";
            return `
              <tr>
                <td class="col-product">${safeText(productLabel)}</td>
                <td class="col-qty">${safeText(qty)}</td>
                <td class="col-total">${safeText(
                  money(lineTotal, fractionDigits)
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
        <title>Invoice</title>
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
          .totals-row strong { font-weight: 700; color: var(--text); }
          .totals-row.total { font-weight: 700; color: var(--violet); }
        </style>
      </head>
      <body>
        <header class="header">
          <div>
            <div class="brand">${safeText(companyName)}</div>
            <div class="brand-sub">${safeText(companySite)}</div>
          </div>
          <div class="doc">
            <div class="doc-title">Invoice</div>
            <div class="doc-meta">Invoice #: ${safeText(
              invoice?.invoiceNumber || invoice?._id
            )}</div>
            <div class="doc-meta">Date: ${safeText(
              formatDate(invoice?.createdAt)
            )}</div>
          </div>
        </header>
        <div class="accent"></div>

        <div class="info-grid">
          <div class="info-card">
            <div class="info-title">Bill to</div>
            <div class="info-item">
              <div class="info-label">Client</div>
              <div class="info-value">${safeText(invoice?.user?.name)}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Email</div>
              <div class="info-value">${safeText(invoice?.user?.email)}</div>
            </div>
          </div>
          <div class="info-card">
            <div class="info-title">Details</div>
            <div class="info-item">
              <div class="info-label">${safeText(detailLabel)}</div>
              <div class="info-value">${safeText(detailValue)}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Due</div>
              <div class="info-value">${safeText(
                formatDate(invoice?.dueDate)
              )}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Status</div>
              <div class="info-value">${safeText(
                invoice?.paymentStatus || "Unpaid"
              )}</div>
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
              <th>${safeText(itemHeader)}</th>
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
            <span>Subtotal</span>
            <span>${safeText(money(subtotal, fractionDigits))}</span>
          </div>
          ${deliveryRowHtml}
          <div class="totals-row total">
            <span>Invoice amount</span>
            <span>${safeText(money(invoiceAmount, fractionDigits))}</span>
          </div>
          <div class="totals-row">
            <span>Amount paid</span>
            <span>${safeText(money(amountPaid, fractionDigits))}</span>
          </div>
          <div class="totals-row total">
            <span>Balance due</span>
            <span>${safeText(money(balanceDue, fractionDigits))}</span>
          </div>
        </div>
      </body>
    </html>
  `;
};

export { renderInvoiceHtml, invoiceFooterTemplate };
