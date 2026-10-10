import assert from "node:assert/strict";
import test from "node:test";
import { checkoutStartResult, duplicatePurchaseOutcome, entitlementAllowsPublish, judgePaymentAccess, judgePaymentMatch, judgeRecovery, reusePendingAttempt } from "./payment-decision.ts";

const paid = {
  signatureMatches: true,
  orderStatus: "paid",
  orderHostId: "host-a",
  requestHostId: "host-a",
};

test("a paid order for this host is accepted", () => {
  assert.equal(judgePaymentAccess(paid), null);
});

test("an invalid signature is rejected before the order is treated as paid", () => {
  assert.equal(judgePaymentAccess({ ...paid, signatureMatches: false }), "bad-signature");
});

test("a valid signature for an unpaid order is rejected", () => {
  assert.equal(judgePaymentAccess({ ...paid, orderStatus: "created" }), "unpaid");
});

test("a payment for a different host is rejected", () => {
  assert.equal(judgePaymentAccess({ ...paid, requestHostId: "host-b" }), "wrong-host");
});

test("the amount, template, and coupon must match the captured order", () => {
  const match = {
    orderAmount: 49900,
    expectedAmount: 49900,
    currency: "INR",
    noteTemplateId: "bloom",
    templateId: "bloom",
    noteCoupon: "",
    coupon: "",
  };
  assert.equal(judgePaymentMatch(match), null);
  assert.equal(judgePaymentMatch({ ...match, templateId: "beach" }), "mismatch");
  assert.equal(judgePaymentMatch({ ...match, orderAmount: 54900 }), "mismatch");
  assert.equal(judgePaymentMatch({ ...match, currency: "USD" }), "mismatch");
  assert.equal(judgePaymentMatch({ ...match, noteCoupon: "WELCOME26" }), "mismatch");
});

test("two finalization requests that collide on the same purchase resolve as one entitlement", () => {
  assert.equal(duplicatePurchaseOutcome(11000, true), "owned");
  assert.equal(duplicatePurchaseOutcome(11000, false), "payment-already-used");
  assert.equal(duplicatePurchaseOutcome(undefined, true), "unexpected");
});

function uniquePurchases() {
  const rows = [];
  let tail = Promise.resolve();
  function insert(row) {
    const run = tail.then(() => {
      const samePurchase = rows.some((item) => item.hostId === row.hostId && item.templateId === row.templateId);
      const samePayment = rows.some((item) => item.paymentId && item.paymentId === row.paymentId);
      if (samePurchase || samePayment) {
        const error = new Error("E11000 duplicate key");
        error.code = 11000;
        throw error;
      }
      rows.push(row);
    });
    tail = run.then(() => {}, () => {});
    return run;
  }
  async function finalize(row) {
    try {
      await insert(row);
      return { owned: true, publish: true, chargeAgain: false };
    } catch (error) {
      const outcome = duplicatePurchaseOutcome(
        error.code,
        rows.some((item) => item.hostId === row.hostId && item.templateId === row.templateId),
      );
      if (outcome === "owned") return { owned: true, publish: true, chargeAgain: false };
      if (outcome === "payment-already-used") return { owned: false, publish: false, chargeAgain: false };
      throw error;
    }
  }
  return { rows, finalize };
}

test("two overlapping inserts leave one purchase and both callers can publish", async () => {
  const ledger = uniquePurchases();
  const row = { hostId: "host-a", templateId: "bloom", paymentId: "pay_overlap" };
  const [left, right] = await Promise.all([ledger.finalize(row), ledger.finalize(row)]);
  assert.equal(ledger.rows.length, 1);
  assert.equal(left.owned, true);
  assert.equal(right.owned, true);
  assert.equal(left.chargeAgain, false);
  assert.equal(right.chargeAgain, false);
  assert.equal(left.publish, true);
  assert.equal(right.publish, true);
});

test("a failed overlapping attempt does not remove the purchase that succeeded", async () => {
  const ledger = uniquePurchases();
  const row = { hostId: "host-a", templateId: "villa", paymentId: "pay_kept" };
  const [failed, recorded] = await Promise.allSettled([
    Promise.reject(Object.assign(new Error("network"), { status: undefined })),
    ledger.finalize(row),
  ]);
  assert.equal(failed.status, "rejected");
  assert.equal(recorded.status, "fulfilled");
  assert.equal(recorded.value.owned, true);
  assert.equal(ledger.rows.length, 1);
  const retry = await ledger.finalize(row);
  assert.equal(retry.owned, true);
  assert.equal(retry.chargeAgain, false);
  assert.equal(ledger.rows.length, 1);
});

const recovery = {
  sameHost: true,
  status: "awaiting-payment",
  expiresAtMs: Date.now() + 60_000,
  now: Date.now(),
  orderFetched: true,
  orderStatus: "paid",
  orderAmount: 49900,
  storedAmount: 49900,
  orderCurrency: "INR",
  storedCurrency: "INR",
  orderHostId: "host-a",
  storedHostId: "host-a",
  orderTemplateId: "bloom",
  storedTemplateId: "bloom",
  orderCoupon: "ADITYA50",
  storedCoupon: "ADITYA50",
  capturedPaymentId: "pay_1",
};

test("server recovery accepts only this host's captured order", () => {
  assert.equal(judgeRecovery(recovery).state, "recover");
  assert.equal(judgeRecovery({ ...recovery, sameHost: false }).state, "wrong-host");
  assert.equal(judgeRecovery({ ...recovery, status: "completed" }).state, "completed");
  assert.equal(judgeRecovery({ ...recovery, status: "failed" }).state, "failed");
  assert.equal(judgeRecovery({ ...recovery, orderFetched: false, orderStatus: "" }).state, "unavailable");
  assert.equal(judgeRecovery({ ...recovery, orderStatus: "created", capturedPaymentId: null }).state, "unpaid");
  assert.equal(judgeRecovery({ ...recovery, orderStatus: "created", capturedPaymentId: null, now: 5_000, expiresAtMs: 4_000 }).state, "expired");
  assert.equal(judgeRecovery({ ...recovery, orderAmount: 54900 }).state, "mismatch");
  assert.equal(judgeRecovery({ ...recovery, orderCurrency: "USD" }).state, "mismatch");
  assert.equal(judgeRecovery({ ...recovery, orderTemplateId: "villa" }).state, "mismatch");
  assert.equal(judgeRecovery({ ...recovery, orderHostId: "host-b" }).state, "mismatch");
  assert.equal(judgeRecovery({ ...recovery, orderCoupon: "" }).state, "mismatch");
  assert.equal(judgeRecovery({ ...recovery, capturedPaymentId: null }).state, "unavailable");
  assert.equal(judgeRecovery({ ...recovery, expiresAtMs: Date.now() - 1 }).state, "recover");
});

test("an unfinished order is reused and a captured one is not charged again", () => {
  const open = {
    status: "awaiting-payment",
    hasOrderId: true,
    amount: 49900,
    coupon: "",
    expiresAtMs: Date.now() + 60_000,
    now: Date.now(),
    requestedAmount: 49900,
    requestedCoupon: "",
  };
  assert.equal(reusePendingAttempt(open), "resume");
  assert.equal(reusePendingAttempt({ ...open, status: "captured" }), "recover");
  assert.equal(reusePendingAttempt({ ...open, requestedAmount: 54900 }), "replace");
  assert.equal(reusePendingAttempt({ ...open, expiresAtMs: Date.now() - 1 }), "replace");
  assert.equal(reusePendingAttempt({ ...open, status: "opening", hasOrderId: false }), "busy");
});

test("a Razorpay order is hidden when its id cannot be stored", () => {
  assert.equal(checkoutStartResult({ recorded: false, gatewayCreated: false, orderIdStored: false }), "not-started");
  assert.equal(checkoutStartResult({ recorded: true, gatewayCreated: false, orderIdStored: false }), "not-started");
  assert.equal(checkoutStartResult({ recorded: true, gatewayCreated: true, orderIdStored: false }), "withheld");
  assert.equal(checkoutStartResult({ recorded: true, gatewayCreated: true, orderIdStored: true }), "ready");
});

test("publishing stays closed until the purchase exists", () => {
  assert.equal(entitlementAllowsPublish(false), false);
  assert.equal(entitlementAllowsPublish(true), true);
});

test("the same captured payment cannot unlock a second template", async () => {
  const ledger = uniquePurchases();
  const first = await ledger.finalize({ hostId: "host-a", templateId: "bloom", paymentId: "pay_once" });
  const second = await ledger.finalize({ hostId: "host-b", templateId: "beach", paymentId: "pay_once" });
  assert.equal(first.owned, true);
  assert.equal(second.owned, false);
  assert.equal(second.publish, false);
  assert.equal(ledger.rows.length, 1);
});
