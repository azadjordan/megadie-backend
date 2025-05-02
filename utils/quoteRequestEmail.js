// utils/quoteRequestEmail.js
export default ({ user, quote }) => `
  <h2 style="color: darkblue;">🟣 New Quote Request</h2>
  <p><strong>Name:</strong> ${user.name}</p>
  <p><strong>Email:</strong> ${user.email}</p>
  <p><strong>Note:</strong> ${quote.clientToAdminNote || "—"}</p>
  <p><strong>Items:</strong></p>
  <ul>
    ${quote.requestedItems.map(item => `
      <li>${item.product?.name || "Unknown"} — ${item.qty} pcs</li>
    `).join("")}
  </ul>
`;
