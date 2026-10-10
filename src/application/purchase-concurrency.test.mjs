import assert from "node:assert/strict";
import test from "node:test";
import { duplicatePurchaseOutcome } from "./payment-decision.ts";

const url = process.env.INVITES_TEST_MONGO;

test("two first-time purchase upserts on MongoDB leave one row", { skip: url ? false : "no isolated MongoDB" }, async () => {
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(url);
  const { PurchaseModel, PendingPaymentModel } = await import("../infrastructure/models.ts");
  await Promise.all([PurchaseModel.syncIndexes(), PendingPaymentModel.syncIndexes()]);
  const hostId = new mongoose.Types.ObjectId();
  const otherHost = new mongoose.Types.ObjectId();
  async function finalize() {
    try {
      await PurchaseModel.updateOne(
        { hostId, templateId: "bloom" },
        { $setOnInsert: { hostId, templateId: "bloom", price: 499, coupon: "", razorpayOrderId: "order_local", razorpayPaymentId: "pay_local" } },
        { upsert: true },
      );
      return "owned";
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : undefined;
      const existing = await PurchaseModel.exists({ hostId, templateId: "bloom" });
      const outcome = duplicatePurchaseOutcome(code, Boolean(existing));
      if (outcome === "owned") return "owned";
      throw error;
    }
  }
  const [left, right] = await Promise.all([finalize(), finalize()]);
  const rows = await PurchaseModel.find({ hostId, templateId: "bloom" });
  assert.equal(left, "owned");
  assert.equal(right, "owned");
  assert.equal(rows.length, 1);
  await PurchaseModel.deleteOne({ hostId, templateId: "bloom" });
  const afterDelete = await PurchaseModel.countDocuments({ hostId, templateId: "bloom" });
  assert.equal(afterDelete, 0);
  await finalize();
  const kept = await PurchaseModel.findOne({ hostId, templateId: "bloom" });
  assert.ok(kept);
  await Promise.allSettled([
    Promise.reject(new Error("network")),
    PurchaseModel.updateOne({ hostId, templateId: "bloom" }, { $setOnInsert: { hostId, templateId: "bloom", price: 499, coupon: "" } }, { upsert: true }),
  ]);
  assert.equal(await PurchaseModel.countDocuments({ hostId, templateId: "bloom" }), 1);

  const templateId = "villa";
  const first = await PendingPaymentModel.create({ hostId, templateId, amount: 49900, currency: "INR", coupon: "", status: "awaiting-payment", razorpayOrderId: "order_pending_local", expiresAt: new Date(Date.now() + 60_000) });
  await assert.rejects(
    PendingPaymentModel.create({ hostId, templateId, amount: 49900, currency: "INR", coupon: "", status: "opening", expiresAt: new Date(Date.now() + 60_000) }),
    (error) => error && error.code === 11000,
  );
  const visible = await PendingPaymentModel.find({ hostId, templateId, status: { $in: ["awaiting-payment", "captured", "failed"] } });
  const hidden = await PendingPaymentModel.find({ hostId: otherHost, templateId });
  assert.equal(visible.length, 1);
  assert.equal(String(visible[0]._id), String(first._id));
  assert.equal(hidden.length, 0);
  await mongoose.disconnect();
});
