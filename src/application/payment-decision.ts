export type AccessRejection = "bad-signature" | "unpaid" | "wrong-host";

export function judgePaymentAccess(input: {
  signatureMatches: boolean;
  orderStatus: string;
  orderHostId: string;
  requestHostId: string;
}): AccessRejection | null {
  if (!input.signatureMatches) return "bad-signature";
  if (input.orderStatus !== "paid") return "unpaid";
  if (!input.orderHostId || input.orderHostId !== input.requestHostId) return "wrong-host";
  return null;
}

export function judgePaymentMatch(input: {
  orderAmount: number;
  expectedAmount: number;
  currency: string;
  noteTemplateId: string;
  templateId: string;
  noteCoupon: string;
  coupon: string;
}): "mismatch" | null {
  if (
    input.orderAmount !== input.expectedAmount ||
    input.currency !== "INR" ||
    input.noteTemplateId !== input.templateId ||
    input.noteCoupon !== input.coupon
  ) {
    return "mismatch";
  }
  return null;
}

export function duplicatePurchaseOutcome(errorCode: number | undefined, hostTemplateExists: boolean) {
  if (errorCode !== 11000) return "unexpected" as const;
  return hostTemplateExists ? ("owned" as const) : ("payment-already-used" as const);
}

export const PENDING_UNPAID_MS = 48 * 60 * 60 * 1000;
export const OPENING_TTL_MS = 15 * 60 * 1000;
export const COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AttemptStatus = "opening" | "awaiting-payment" | "captured" | "completed" | "failed" | "expired";

export type RecoveryJudgement =
  | { state: "wrong-host" }
  | { state: "completed" }
  | { state: "failed" }
  | { state: "expired" }
  | { state: "unavailable" }
  | { state: "unpaid" }
  | { state: "mismatch" }
  | { state: "recover" };

export function judgeRecovery(input: {
  sameHost: boolean;
  status: AttemptStatus;
  expiresAtMs: number | null;
  now: number;
  orderFetched: boolean;
  orderStatus: string;
  orderAmount: number;
  storedAmount: number;
  orderCurrency: string;
  storedCurrency: string;
  orderHostId: string;
  storedHostId: string;
  orderTemplateId: string;
  storedTemplateId: string;
  orderCoupon: string;
  storedCoupon: string;
  capturedPaymentId: string | null;
}): RecoveryJudgement {
  if (!input.sameHost) return { state: "wrong-host" };
  if (input.status === "completed") return { state: "completed" };
  if (input.status === "failed") return { state: "failed" };
  if (!input.orderFetched) return { state: "unavailable" };
  const aligned =
    input.orderAmount === input.storedAmount &&
    input.orderCurrency === input.storedCurrency &&
    input.storedCurrency === "INR" &&
    input.orderHostId !== "" &&
    input.orderHostId === input.storedHostId &&
    input.orderTemplateId === input.storedTemplateId &&
    input.orderCoupon === input.storedCoupon;
  if (!aligned) return { state: "mismatch" };
  if (input.orderStatus !== "paid") {
    if (input.expiresAtMs !== null && input.now > input.expiresAtMs) return { state: "expired" };
    return { state: "unpaid" };
  }
  if (!input.capturedPaymentId) return { state: "unavailable" };
  return { state: "recover" };
}

export function reusePendingAttempt(input: {
  status: AttemptStatus;
  hasOrderId: boolean;
  amount: number;
  coupon: string;
  expiresAtMs: number | null;
  now: number;
  requestedAmount: number;
  requestedCoupon: string;
}): "recover" | "resume" | "replace" | "busy" {
  if (input.status === "captured") return "recover";
  if (input.status === "opening" && !input.hasOrderId) {
    return input.expiresAtMs !== null && input.now > input.expiresAtMs ? "replace" : "busy";
  }
  const samePrice = input.amount === input.requestedAmount && input.coupon === input.requestedCoupon;
  const fresh = input.expiresAtMs === null || input.now <= input.expiresAtMs;
  if (input.status === "awaiting-payment" && input.hasOrderId && samePrice && fresh) return "resume";
  return "replace";
}

export function checkoutStartResult(input: { recorded: boolean; gatewayCreated: boolean; orderIdStored: boolean }) {
  if (!input.recorded || !input.gatewayCreated) return "not-started" as const;
  if (!input.orderIdStored) return "withheld" as const;
  return "ready" as const;
}

export function entitlementAllowsPublish(owned: boolean) {
  return owned;
}
