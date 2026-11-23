import { createHash } from "node:crypto";
import mongoose from "mongoose";

const uuidPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

export async function recordPaymentRequest(req, res, target, details, record) {
  const suppliedKey = req.get("Idempotency-Key");
  if (suppliedKey === undefined) {
    return mongoose.connection.transaction(record);
  }
  if (!uuidPattern.test(suppliedKey)) {
    res.status(400);
    throw new Error("Invalid payment request key.");
  }

  const key = suppliedKey.toLowerCase();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([String(req.user._id), target, details]))
    .digest("hex");
  const requests = mongoose.connection.db.collection("paymentrequests");
  let duplicateClaim;

  function replay(existing) {
    if (existing.fingerprint !== fingerprint) {
      res.status(409);
      throw new Error("This payment request key was already used for different details.");
    }
    return JSON.parse(existing.response);
  }

  try {
    return await mongoose.connection.transaction(async (session) => {
      const existing = await requests.findOne({ _id: key }, { session });
      if (existing) return replay(existing);

      try {
        await requests.insertOne({ _id: key, fingerprint }, { session });
      } catch (error) {
        if (error.code === 11000) duplicateClaim = error;
        throw error;
      }

      const result = await record(session);
      await requests.updateOne(
        { _id: key },
        { $set: { response: JSON.stringify(result) } },
        { session }
      );
      return result;
    });
  } catch (error) {
    if (error !== duplicateClaim) throw error;
    const existing = await requests.findOne({ _id: key });
    if (!existing) throw error;
    return replay(existing);
  }
}
