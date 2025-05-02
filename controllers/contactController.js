// In your backend (e.g., controllers/contactController.js)
import asyncHandler from "../middleware/asyncHandler.js";
import sendEmail from "../utils/sendEmail.js";

export const handleContact = asyncHandler(async (req, res) => {
  const { name, phone, message } = req.body;

  if (!name || !phone || !message) {
    res.status(400);
    throw new Error("All fields are required");
  }

  const subject = "New Contact Message from Megadie.com";
  const html = `
    <h3>You've received a new message via the contact form:</h3>
    <p><strong>Name:</strong> ${name}</p>
    <p><strong>Phone:</strong> ${phone}</p>
    <p><strong>Message:</strong></p>
    <p>${message}</p>
  `;

  await sendEmail({
    to: ["azadkkurdi@gmail.com", "almomani95hu@gmail.com"],
    subject,
    html,
  });

  res.status(200).json({ message: "Message sent successfully" });
});