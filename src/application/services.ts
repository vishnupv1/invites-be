import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import catalogSeedFile from "../infrastructure/catalog-seed.json" with { type: "json" };
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import Razorpay from "razorpay";
import { config } from "../config.js";
import { AppError } from "../domain/errors.js";
import { COMPLETED_TTL_MS, OPENING_TTL_MS, PENDING_UNPAID_MS, duplicatePurchaseOutcome, entitlementAllowsPublish, judgePaymentAccess, judgePaymentMatch, judgeRecovery, reusePendingAttempt, type AttemptStatus } from "./payment-decision.js";
import { draftFieldsSchema, editorStateSchema, inviteFieldsSchema, type EditorState, type InviteFields } from "../domain/invite-fields.js";
import { CouponModel, EventModel, GreetingModel, HostModel, InviteModel, MediaModel, PendingPaymentModel, PurchaseModel, TemplateModel } from "../infrastructure/models.js";

const uploadsDir = path.resolve(process.cwd(), "uploads");

const scryptAsync = promisify(scrypt);

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 32)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

async function passwordMatches(password: string, stored: string) {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex) return false;
  const derived = (await scryptAsync(password, salt, 32)) as Buffer;
  const expected = Buffer.from(hex, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function issueToken() {
  const token = randomBytes(24).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

function slug() {
  return randomBytes(6).toString("base64url");
}

function hostView(host: { id?: unknown; email: string; name: string }, token: string) {
  return { token, host: { id: String(host.id), email: host.email, name: host.name } };
}

export async function ensureAdmin() {
  const email = config.adminEmail;
  const passwordHash = await hashPassword(config.adminPassword);
  const existing = await HostModel.findOne({ email });
  if (existing) {
    existing.name = existing.name || "Admin";
    existing.passwordHash = passwordHash;
    await existing.save();
    return;
  }
  await HostModel.create({
    email,
    name: "Admin",
    passwordHash,
    tokenHash: issueToken().tokenHash,
  });
}

function isDuplicateKey(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: number }).code === 11000;
}

export async function openSession(email: string, name: string) {
  const normalized = email.trim().toLowerCase();
  const existing = await HostModel.findOne({ email: normalized });
  if (existing) throw new AppError(401, "Log in to use that email.");
  const issued = issueToken();
  try {
    const host = await HostModel.create({
      email: normalized,
      name: name.trim() || "Host",
      tokenHash: issued.tokenHash,
    });
    return hostView(host, issued.token);
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(401, "Log in to use that email.");
    throw error;
  }
}


async function googleProfile(code: string) {
  if (!config.googleClientId || !config.googleClientSecret) throw new AppError(503, "Google sign-in is not set up.");
  const exchanged = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: "postmessage",
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!exchanged.ok) throw new AppError(401, "Google could not confirm that sign-in.");
  const tokens = (await exchanged.json()) as { id_token?: string };
  if (!tokens.id_token) throw new AppError(401, "Google could not confirm that sign-in.");
  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!info.ok) throw new AppError(401, "Google could not confirm that sign-in.");
  const token = (await info.json()) as { aud?: string; email?: string; email_verified?: string | boolean; name?: string };
  if (token.aud !== config.googleClientId) throw new AppError(401, "That Google sign-in is for a different app.");
  const verified = token.email_verified === true || token.email_verified === "true";
  if (!token.email || !verified) throw new AppError(401, "Google did not confirm that email.");
  return { email: token.email.trim().toLowerCase(), name: token.name?.trim() || "" };
}

export async function signInWithGoogle(code: string) {
  const profile = await googleProfile(code);
  const issued = issueToken();
  const name = profile.name || profile.email.split("@")[0] || "Host";
  const existing = await HostModel.findOne({ email: profile.email });
  if (existing) {
    if (!existing.name || existing.name === "Host") existing.name = name;
    existing.tokenHash = issued.tokenHash;
    await existing.save();
    return { ...hostView(existing, issued.token), created: false };
  }
  const host = await HostModel.create({
    email: profile.email,
    name,
    tokenHash: issued.tokenHash,
  });
  return { ...hostView(host, issued.token), created: true };
}

export async function signUp(name: string, email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const issued = issueToken();
  const existing = await HostModel.findOne({ email: normalized });
  if (existing?.passwordHash) {
    throw new AppError(409, "An account with that email already exists. Log in instead.");
  }
  if (existing) {
    existing.name = name.trim() || existing.name;
    existing.passwordHash = passwordHash;
    existing.tokenHash = issued.tokenHash;
    await existing.save();
    return hostView(existing, issued.token);
  }
  const host = await HostModel.create({
    email: normalized,
    name: name.trim() || "Host",
    passwordHash,
    tokenHash: issued.tokenHash,
  });
  return hostView(host, issued.token);
}

export async function logIn(email: string, password: string) {
  const host = await HostModel.findOne({ email: email.trim().toLowerCase() });
  if (!host?.passwordHash) throw new AppError(401, "No account for that email. Create one to continue.");
  const ok = await passwordMatches(password, host.passwordHash);
  if (!ok) throw new AppError(401, "That password doesn't match.");
  const issued = issueToken();
  host.tokenHash = issued.tokenHash;
  await host.save();
  return hostView(host, issued.token);
}

export async function adminSummary(token: string | undefined) {
  const host = await hostFromToken(token);
  if (!config.adminEmails.includes(host.email)) throw new AppError(403, "This account is not an admin.");
  const [hosts, invites, purchases] = await Promise.all([
    HostModel.find().sort({ createdAt: -1 }),
    InviteModel.find().sort({ createdAt: -1 }),
    PurchaseModel.find().sort({ createdAt: -1 }),
  ]);
  const demo = (email: string) => email.endsWith("@example.com") || email === config.adminEmail;
  const realHosts = hosts.filter((item) => !demo(item.email));
  const realIds = new Set(realHosts.map((item) => String(item._id)));
  const hostName = new Map(realHosts.map((item) => [String(item._id), { name: item.name, email: item.email }]));
  const realInvites = invites.filter((invite) => realIds.has(String(invite.hostId)));
  const realPurchases = purchases.filter((row) => realIds.has(String(row.hostId)));
  const replyCounts = await Promise.all(
    realInvites.map(async (invite) => {
      const [replies, yes] = await Promise.all([
        GreetingModel.countDocuments({ inviteId: invite.id }),
        GreetingModel.countDocuments({ inviteId: invite.id, attending: true }),
      ]);
      return { replies, yes };
    }),
  );
  const eventsByHost = new Map<string, number>();
  for (const invite of realInvites) {
    const id = String(invite.hostId);
    eventsByHost.set(id, (eventsByHost.get(id) ?? 0) + 1);
  }
  return {
    admin: { name: host.name, email: host.email },
    users: realHosts.map((item) => ({
      id: String(item._id),
      name: item.name,
      email: item.email,
      events: eventsByHost.get(String(item._id)) ?? 0,
      joined: item.createdAt?.toISOString() ?? "",
    })),
    events: realInvites.map((invite, index) => ({
      id: String(invite._id),
      name: invite.names,
      templateId: invite.templateId,
      host: hostName.get(String(invite.hostId))?.name ?? "",
      date: invite.date,
      replies: replyCounts[index]?.replies ?? 0,
      yes: replyCounts[index]?.yes ?? 0,
      code: invite.slug,
    })),
    purchases: realPurchases.map((row) => ({
      id: String(row._id),
      templateId: row.templateId,
      host: hostName.get(String(row.hostId))?.name ?? "",
      price: row.price,
      at: row.createdAt?.toISOString() ?? "",
    })),
  };
}

export async function endSession(token: string | undefined) {
  const host = await hostFromToken(token);
  host.tokenHash = issueToken().tokenHash;
  await host.save();
}

export async function hostFromToken(token: string | undefined) {
  if (!token) throw new AppError(401, "Sign in is required.");
  const host = await HostModel.findOne({ tokenHash: hashToken(token) });
  if (!host) throw new AppError(401, "That session is no longer valid.");
  return host;
}

export async function renameHost(token: string | undefined, name: string) {
  const host = await hostFromToken(token);
  host.name = name.trim();
  await host.save();
  return { id: String(host.id), email: host.email, name: host.name };
}

type SeedEvent = { id: string; label: string; cardLabel: string; detailLabel: string; namesLabel: string; hostsLabel: string; titleLabel: string };
type SeedTemplate = {
  id: string;
  name: string;
  style: string;
  price: number;
  free: boolean;
  events: string[];
  tagline: string;
  description: string;
  asks: unknown;
  meta?: unknown;
  samples: unknown;
};

function catalogSeed() {
  return catalogSeedFile as { events: SeedEvent[]; templates: SeedTemplate[] };
}

export async function ensureCatalog() {
  const seed = catalogSeed();
  for (const event of seed.events) {
    await EventModel.updateOne({ id: event.id }, { $setOnInsert: event }, { upsert: true });
  }
  const ids = seed.templates.map((template) => template.id);
  for (const template of seed.templates) {
    await TemplateModel.updateOne({ id: template.id }, { $set: template }, { upsert: true });
  }
  await TemplateModel.deleteMany({ id: { $nin: ids } });
}

function publicEvent(row: { id: string; label: string; cardLabel: string; detailLabel?: string; namesLabel?: string; hostsLabel?: string; titleLabel?: string }) {
  return {
    id: row.id,
    label: row.label,
    cardLabel: row.cardLabel,
    detailLabel: row.detailLabel ?? "",
    namesLabel: row.namesLabel ?? "",
    hostsLabel: row.hostsLabel ?? "",
    titleLabel: row.titleLabel ?? "",
  };
}

function publicTemplate(row: SeedTemplate) {
  return {
    id: row.id,
    name: row.name,
    style: row.style,
    price: row.price,
    free: row.free,
    events: row.events,
    tagline: row.tagline,
    description: row.description,
    asks: row.asks,
    meta: row.meta ?? null,
    samples: row.samples,
  };
}

export async function listEvents() {
  const rows = await EventModel.find().sort({ label: 1 }).lean();
  return rows.map(publicEvent);
}

export async function listTemplates() {
  const rows = await TemplateModel.find().sort({ name: 1 }).lean();
  return rows.map((row) => publicTemplate(row as SeedTemplate));
}

export async function getCatalogTemplate(id: string) {
  const row = await TemplateModel.findOne({ id }).lean();
  return row ? publicTemplate(row as SeedTemplate) : null;
}

export async function ensureCoupons() {
  await CouponModel.updateOne({ code: "WELCOME26" }, { $set: { active: true, percent: 100 } }, { upsert: true });
  await CouponModel.updateOne({ code: "ADITYA50" }, { $set: { active: true, percent: 50 } }, { upsert: true });
}

function discountPercent(value: unknown) {
  if (value == null) return 100;
  const percent = Number(value);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new AppError(400, "That coupon code is not valid.");
  }
  return percent;
}

export function discountRupees(price: number, percentOff: number) {
  return Math.round((price * percentOff) / 100);
}

export async function verifyCoupon(code: string) {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new AppError(400, "Enter a coupon code.");
  const coupon = await CouponModel.findOne({ code: normalized }).lean();
  if (!coupon || coupon.active === false) throw new AppError(400, "That coupon code is not valid.");
  return { valid: true as const, code: coupon.code, percent: discountPercent(coupon.percent) };
}

function razorpayClient() {
  if (!config.razorpayKeyId || !config.razorpayKeySecret) {
    throw new AppError(503, "Payments are not configured yet.");
  }
  return new Razorpay({ key_id: config.razorpayKeyId, key_secret: config.razorpayKeySecret });
}

function throwRazorpayError(error: unknown): never {
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 0;
  if (statusCode === 401) throw new AppError(401, "Razorpay credentials were rejected.");
  throw new AppError(500, "Razorpay could not create the order. Try again.");
}

const SUPPORT = "We could not match that payment to this design. Contact support. Do not pay again.";
const EXPIRED = "That checkout expired. No payment was taken.";
const UNAVAILABLE = "We could not confirm that payment just now. Try again in a moment. You will not be charged again.";
const NOT_FOUND = "That payment attempt was not found.";

function noteValue(notes: unknown, key: string) {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) return "";
  const value = (notes as Record<string, unknown>)[key];
  return value == null ? "" : String(value);
}

function attemptStatus(value: string): AttemptStatus {
  if (
    value === "opening" ||
    value === "awaiting-payment" ||
    value === "captured" ||
    value === "completed" ||
    value === "failed" ||
    value === "expired"
  ) {
    return value;
  }
  return "failed";
}

async function markAttemptCompleted(hostId: unknown, orderId: string) {
  const keepUntil = new Date(Date.now() + COMPLETED_TTL_MS);
  await PendingPaymentModel.updateOne(
    { hostId, razorpayOrderId: orderId, status: { $in: ["opening", "awaiting-payment", "captured"] } },
    { $set: { status: "completed", finalizedAt: new Date(), expiresAt: keepUntil } },
  );
}

async function saveOwnedPurchase(
  hostId: unknown,
  templateId: string,
  price: number,
  coupon: string,
  orderId?: string,
  paymentId?: string,
) {
  try {
    await PurchaseModel.updateOne(
      { hostId, templateId },
      {
        $setOnInsert: {
          hostId,
          templateId,
          price,
          coupon,
          ...(orderId && paymentId ? { razorpayOrderId: orderId, razorpayPaymentId: paymentId } : {}),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : undefined;
    const outcome = duplicatePurchaseOutcome(code, false);
    if (outcome === "unexpected") throw error;
    const existing = await PurchaseModel.exists({ hostId, templateId });
    if (duplicatePurchaseOutcome(code, Boolean(existing)) !== "owned") {
      throw new AppError(409, "That payment is already used.");
    }
  }
  if (orderId) await markAttemptCompleted(hostId, orderId);
  return { templateId, owned: true as const };
}

function payResponse(
  attempt: { id?: unknown; _id?: unknown; razorpayOrderId?: string | null; amount: number; currency: string },
  reused: boolean,
) {
  return {
    action: "pay" as const,
    keyId: config.razorpayKeyId,
    orderId: attempt.razorpayOrderId || "",
    amount: attempt.amount,
    currency: attempt.currency,
    attemptId: String(attempt.id ?? attempt._id),
    reused,
  };
}

export async function createPaymentOrder(token: string | undefined, templateId: string, coupon?: string) {
  const host = await hostFromToken(token);
  const template = await getCatalogTemplate(templateId);
  if (!template) throw new AppError(404, "Unknown template.");
  if (template.free) throw new AppError(400, "This template is free.");
  if (await PurchaseModel.exists({ hostId: host.id, templateId })) {
    throw new AppError(409, "You already own this template.");
  }
  const verified = coupon?.trim() ? await verifyCoupon(coupon) : null;
  const payable = template.price - discountRupees(template.price, verified?.percent ?? 0);
  if (payable <= 0) throw new AppError(400, "This coupon makes the template free. No payment is needed.");
  const amount = payable * 100;
  if (!Number.isSafeInteger(amount) || amount < 100) {
    throw new AppError(400, "Payment amount must be at least ₹1.");
  }
  const couponCode = verified?.code ?? "";
  const now = Date.now();
  const open = await PendingPaymentModel.findOne({
    hostId: host.id,
    templateId,
    status: { $in: ["opening", "awaiting-payment", "captured"] },
  });
  if (open) {
    const decision = reusePendingAttempt({
      status: attemptStatus(open.status),
      hasOrderId: Boolean(open.razorpayOrderId),
      amount: open.amount,
      coupon: open.coupon || "",
      expiresAtMs: open.expiresAt ? open.expiresAt.getTime() : null,
      now,
      requestedAmount: amount,
      requestedCoupon: couponCode,
    });
    if (decision === "recover") return { action: "recover" as const, attemptId: String(open.id) };
    if (decision === "resume" && open.razorpayOrderId) return payResponse(open, true);
    if (decision === "busy") throw new AppError(503, "Checkout is already starting. You have not been charged.");
    open.status = "expired";
    open.expiresAt = new Date();
    await open.save();
  }
  let attempt;
  try {
    attempt = await PendingPaymentModel.create({
      hostId: host.id,
      templateId,
      amount,
      currency: "INR",
      coupon: couponCode,
      status: "opening",
      expiresAt: new Date(now + OPENING_TTL_MS),
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : undefined;
    if (code !== 11000) throw new AppError(500, "Could not start checkout. You have not been charged.");
    const again = await PendingPaymentModel.findOne({
      hostId: host.id,
      templateId,
      status: { $in: ["opening", "awaiting-payment", "captured"] },
    });
    if (again?.status === "captured") return { action: "recover" as const, attemptId: String(again.id) };
    if (again?.razorpayOrderId) return payResponse(again, true);
    throw new AppError(503, "Checkout is already starting. You have not been charged.");
  }
  let order: { id: string; amount: number | string; currency: string };
  try {
    order = await razorpayClient().orders.create({
      amount,
      currency: "INR",
      receipt: `p_${Date.now()}_${randomBytes(4).toString("hex")}`,
      notes: { hostId: String(host.id), templateId, coupon: couponCode, attemptId: String(attempt.id) },
    });
  } catch (error) {
    attempt.status = "failed";
    attempt.expiresAt = new Date(Date.now() + COMPLETED_TTL_MS);
    await attempt.save().catch(() => undefined);
    throwRazorpayError(error);
  }
  attempt.razorpayOrderId = order.id;
  attempt.status = "awaiting-payment";
  attempt.expiresAt = new Date(Date.now() + PENDING_UNPAID_MS);
  try {
    await attempt.save();
  } catch {
    try {
      await attempt.save();
    } catch {
      attempt.status = "failed";
      await attempt.save().catch(() => undefined);
      throw new AppError(500, "Could not start checkout. You have not been charged.");
    }
  }
  return payResponse(attempt, false);
}

type PaymentProof = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

async function verifyPaymentProof(token: string | undefined, payment: PaymentProof) {
  const host = await hostFromToken(token);
  if (!config.razorpayKeySecret) throw new AppError(503, "Payments are not configured yet.");
  const expected = createHmac("sha256", config.razorpayKeySecret)
    .update(`${payment.razorpay_order_id}|${payment.razorpay_payment_id}`)
    .digest("hex");
  const actual = Buffer.from(payment.razorpay_signature, "hex");
  const wanted = Buffer.from(expected, "hex");
  const signatureMatches = actual.length === wanted.length && timingSafeEqual(actual, wanted);
  const order = signatureMatches ? await razorpayClient().orders.fetch(payment.razorpay_order_id) : null;
  const rejection = judgePaymentAccess({
    signatureMatches,
    orderStatus: String(order?.status ?? ""),
    orderHostId: String(order?.notes?.hostId ?? ""),
    requestHostId: String(host.id),
  });
  if (rejection === "bad-signature") throw new AppError(400, "Razorpay could not verify that payment.");
  if (rejection) throw new AppError(400, "That payment does not match this purchase.");
  return { host, order: order! };
}

export async function verifyPayment(token: string | undefined, payment: PaymentProof) {
  await verifyPaymentProof(token, payment);
  return { success: true as const };
}

export async function purchaseTemplate(
  token: string | undefined,
  templateId: string,
  coupon?: string,
  payment?: PaymentProof,
) {
  const host = await hostFromToken(token);
  const template = await getCatalogTemplate(templateId);
  if (!template) throw new AppError(404, "Unknown template.");
  if (template.free) return { templateId, owned: true };
  let verified: { code: string; percent: number } | null = null;
  let trustCapturedAmount = false;
  if (coupon?.trim()) {
    try {
      verified = await verifyCoupon(coupon);
    } catch (error) {
      if (!payment || !(error instanceof AppError) || error.status !== 400) throw error;
      trustCapturedAmount = true;
      verified = { code: coupon.trim().toUpperCase(), percent: 0 };
    }
  }
  const payable = template.price - discountRupees(template.price, verified?.percent ?? 0);
  let recordedPrice = payable;
  if (payable > 0 || trustCapturedAmount) {
    if (!payment) throw new AppError(402, "Complete the payment to unlock this template.");
    const { order } = await verifyPaymentProof(token, payment);
    const notes = order.notes ?? {};
    if (
      judgePaymentMatch({
        orderAmount: Number(order.amount),
        expectedAmount: trustCapturedAmount ? Number(order.amount) : payable * 100,
        currency: String(order.currency),
        noteTemplateId: String(notes.templateId ?? ""),
        templateId,
        noteCoupon: String(notes.coupon ?? ""),
        coupon: verified?.code ?? "",
      })
    ) {
      throw new AppError(400, "That payment does not match this purchase.");
    }
    if (trustCapturedAmount) recordedPrice = Number(order.amount) / 100;
  }
  return saveOwnedPurchase(
    host.id,
    templateId,
    recordedPrice,
    verified?.code ?? "",
    payment?.razorpay_order_id,
    payment?.razorpay_payment_id,
  );
}

export async function listPurchases(token: string | undefined) {
  const host = await hostFromToken(token);
  const rows = await PurchaseModel.find({ hostId: host.id }).lean();
  return rows.map((row) => row.templateId);
}

async function assertCanUse(hostId: string, templateId: string) {
  const template = await getCatalogTemplate(templateId);
  if (!template) throw new AppError(404, "Unknown template.");
  if (template.free) return;
  const owned = await PurchaseModel.exists({ hostId, templateId });
  if (!entitlementAllowsPublish(Boolean(owned))) throw new AppError(402, "Pay for this template before publishing.");
}

export async function listPendingPayments(token: string | undefined, templateId: string) {
  const host = await hostFromToken(token);
  const rows = await PendingPaymentModel.find({
    hostId: host.id,
    templateId,
    status: { $in: ["awaiting-payment", "captured", "failed"] },
  }).sort({ createdAt: -1 });
  const ranked = [...rows].sort((left, right) => {
    const weight = (status: string) => (status === "captured" ? 0 : status === "awaiting-payment" ? 1 : 2);
    return weight(left.status) - weight(right.status);
  });
  const chosen = ranked[0];
  if (!chosen) return { attempts: [] as { id: string; templateId: string; amount: number; currency: string; coupon: string; status: string }[] };
  return {
    attempts: [
      {
        id: String(chosen.id),
        templateId: chosen.templateId,
        amount: chosen.amount,
        currency: chosen.currency,
        coupon: chosen.coupon || "",
        status: chosen.status,
      },
    ],
  };
}

export async function recoverPendingPayment(token: string | undefined, attemptId: string, finalize: boolean) {
  const host = await hostFromToken(token);
  const attempt = await PendingPaymentModel.findOne({ _id: attemptId, hostId: host.id });
  if (!attempt) throw new AppError(404, NOT_FOUND);
  if (attempt.status === "completed") {
    const purchase = await PurchaseModel.findOne({ hostId: host.id, templateId: attempt.templateId }).lean();
    return {
      state: "completed" as const,
      templateId: attempt.templateId,
      coupon: attempt.coupon || "",
      amount: attempt.amount,
      currency: attempt.currency,
      paymentId: purchase?.razorpayPaymentId || "",
    };
  }
  if (attempt.status === "failed") throw new AppError(409, SUPPORT);
  if (!attempt.razorpayOrderId) throw new AppError(503, UNAVAILABLE);
  let order: { amount?: number | string; currency?: string; status?: string; notes?: unknown };
  let capturedPaymentId: string | null = null;
  let orderFetched = false;
  try {
    order = await razorpayClient().orders.fetch(attempt.razorpayOrderId);
    orderFetched = true;
    if (String(order.status) === "paid") {
      const payments = await razorpayClient().orders.fetchPayments(attempt.razorpayOrderId);
      const captured = payments.items.find((item) => item.status === "captured" && item.id && item.order_id === attempt.razorpayOrderId);
      capturedPaymentId = captured?.id || null;
    }
  } catch {
    throw new AppError(503, UNAVAILABLE);
  }
  const judgement = judgeRecovery({
    sameHost: true,
    status: attemptStatus(attempt.status),
    expiresAtMs: attempt.expiresAt ? attempt.expiresAt.getTime() : null,
    now: Date.now(),
    orderFetched,
    orderStatus: String(order.status ?? ""),
    orderAmount: Number(order.amount),
    storedAmount: attempt.amount,
    orderCurrency: String(order.currency ?? ""),
    storedCurrency: attempt.currency,
    orderHostId: noteValue(order.notes, "hostId"),
    storedHostId: String(host.id),
    orderTemplateId: noteValue(order.notes, "templateId"),
    storedTemplateId: attempt.templateId,
    orderCoupon: noteValue(order.notes, "coupon"),
    storedCoupon: attempt.coupon || "",
    capturedPaymentId,
  });
  if (judgement.state === "mismatch" || judgement.state === "failed") {
    attempt.status = "failed";
    attempt.expiresAt = new Date(Date.now() + COMPLETED_TTL_MS);
    await attempt.save().catch(() => undefined);
    throw new AppError(409, SUPPORT);
  }
  if (judgement.state === "expired") {
    attempt.status = "expired";
    attempt.expiresAt = new Date();
    await attempt.save().catch(() => undefined);
    throw new AppError(410, EXPIRED);
  }
  if (judgement.state === "unavailable") throw new AppError(503, UNAVAILABLE);
  if (judgement.state === "unpaid") {
    return {
      state: "unpaid" as const,
      attemptId: String(attempt.id),
      templateId: attempt.templateId,
      orderId: attempt.razorpayOrderId,
      amount: attempt.amount,
      currency: attempt.currency,
      coupon: attempt.coupon || "",
      keyId: config.razorpayKeyId,
    };
  }
  if (attempt.status !== "captured") {
    await PendingPaymentModel.updateOne({ _id: attempt.id }, { $set: { status: "captured" }, $unset: { expiresAt: 1 } });
    attempt.status = "captured";
  }
  if (!finalize || !capturedPaymentId) {
    return {
      state: "captured" as const,
      attemptId: String(attempt.id),
      templateId: attempt.templateId,
      amount: attempt.amount,
      currency: attempt.currency,
      coupon: attempt.coupon || "",
    };
  }
  const saved = await saveOwnedPurchase(
    host.id,
    attempt.templateId,
    attempt.amount / 100,
    attempt.coupon || "",
    attempt.razorpayOrderId,
    capturedPaymentId,
  );
  return {
    state: "recovered" as const,
    owned: saved.owned,
    templateId: attempt.templateId,
    paymentId: capturedPaymentId,
    coupon: attempt.coupon || "",
    amount: attempt.amount,
    currency: attempt.currency,
  };
}

export async function createInvite(token: string | undefined, templateId: string, fields: InviteFields) {
  const host = await hostFromToken(token);
  await assertCanUse(host.id, templateId);
  const parsed = inviteFieldsSchema.parse(fields);
  const invite = await InviteModel.create({
    hostId: host.id,
    templateId,
    slug: slug(),
    status: "live",
    names: parsed.names,
    title: parsed.title,
    date: parsed.date,
    fields: parsed,
  });
  return toInvite(invite, 0, 0);
}

export async function saveInvite(
  token: string | undefined,
  input: { id?: string; templateId: string; fields: InviteFields; editor?: EditorState },
) {
  const host = await hostFromToken(token);
  const template = await getCatalogTemplate(input.templateId);
  if (!template) throw new AppError(404, "Unknown template.");
  const parsed = draftFieldsSchema.parse(input.fields);
  const editor = input.editor ? editorStateSchema.parse(input.editor) : undefined;
  const names = parsed.names.trim() || "Untitled invitation";
  if (input.id) {
    const invite = await InviteModel.findOne({ _id: input.id, hostId: host.id });
    if (!invite) throw new AppError(404, "Invitation not found.");
    invite.templateId = input.templateId;
    invite.names = names;
    invite.title = parsed.title;
    invite.date = parsed.date || invite.date || "";
    invite.fields = parsed;
    if (editor) invite.editor = editor;
    invite.markModified("fields");
    invite.markModified("editor");
    await invite.save();
    return toInvite(invite, await GreetingModel.countDocuments({ inviteId: invite.id }), await GreetingModel.countDocuments({ inviteId: invite.id, attending: true }));
  }
  const invite = await InviteModel.create({
    hostId: host.id,
    templateId: input.templateId,
    slug: slug(),
    status: "draft",
    names,
    title: parsed.title,
    date: parsed.date || "",
    fields: parsed,
    editor,
  });
  return toInvite(invite, 0, 0);
}

export async function publishInvite(token: string | undefined, id: string) {
  const host = await hostFromToken(token);
  const invite = await InviteModel.findOne({ _id: id, hostId: host.id });
  if (!invite) throw new AppError(404, "Invitation not found.");
  if (invite.status !== "draft") return toInvite(invite, await GreetingModel.countDocuments({ inviteId: invite.id }), await GreetingModel.countDocuments({ inviteId: invite.id, attending: true }));
  await assertCanUse(host.id, invite.templateId);
  const names = String(invite.fields?.names ?? "").trim();
  const date = String(invite.fields?.date ?? "").trim();
  if (!names || date.length < 8) throw new AppError(400, "Add the names and a date before publishing.");
  invite.names = names;
  invite.status = "live";
  await invite.save();
  return toInvite(invite, await GreetingModel.countDocuments({ inviteId: invite.id }), await GreetingModel.countDocuments({ inviteId: invite.id, attending: true }));
}

export async function getOwnInvite(token: string | undefined, id: string) {
  const host = await hostFromToken(token);
  const invite = await InviteModel.findOne({ _id: id, hostId: host.id });
  if (!invite) throw new AppError(404, "Invitation not found.");
  const [replies, yes] = await Promise.all([
    GreetingModel.countDocuments({ inviteId: invite.id }),
    GreetingModel.countDocuments({ inviteId: invite.id, attending: true }),
  ]);
  return { ...toInvite(invite, replies, yes), fields: invite.fields, editor: invite.editor ?? null };
}

export async function listInvites(token: string | undefined) {
  const host = await hostFromToken(token);
  const invites = await InviteModel.find({ hostId: host.id }).sort({ createdAt: -1 });
  return Promise.all(
    invites.map(async (invite) => {
      const [replies, yes] = await Promise.all([
        GreetingModel.countDocuments({ inviteId: invite.id }),
        GreetingModel.countDocuments({ inviteId: invite.id, attending: true }),
      ]);
      return toInvite(invite, replies, yes);
    }),
  );
}

export async function listGreetings(token: string | undefined, slugValue: string) {
  const host = await hostFromToken(token);
  const invite = await InviteModel.findOne({ slug: slugValue, hostId: host.id });
  if (!invite) throw new AppError(404, "Invitation not found.");
  const rows = await GreetingModel.find({ inviteId: invite.id }).sort({ createdAt: -1 });
  return rows.map((row) => ({
    id: String(row._id),
    name: row.name,
    note: row.note,
    attending: row.attending,
    at: row.createdAt?.toISOString() ?? "",
  }));
}

export async function getPublicInvite(slugValue: string) {
  const invite = await InviteModel.findOne({ slug: slugValue });
  if (!invite || invite.status === "draft") throw new AppError(404, "Invitation not found.");
  const greetings = await GreetingModel.find({ inviteId: invite.id }).sort({ createdAt: -1 });
  const editor = invite.editor as { swatch?: unknown } | null | undefined;
  return {
    slug: invite.slug,
    templateId: invite.templateId,
    fields: invite.fields,
    swatch: typeof editor?.swatch === "string" ? editor.swatch : "",
    greetings: greetings
      .filter((row) => row.note.trim())
      .map((row) => ({ name: row.name, note: row.note, attending: row.attending })),
  };
}

export async function addGreeting(
  slugValue: string,
  input: { name: string; note: string; attending: boolean; replyToken?: string },
) {
  const invite = await InviteModel.findOne({ slug: slugValue });
  if (!invite || invite.status === "draft") throw new AppError(404, "Invitation not found.");
  const name = input.name.trim();
  const note = input.note.trim();
  const token = input.replyToken?.trim();
  if (token) {
    const existing = await GreetingModel.findOne({ inviteId: invite.id, replyTokenHash: hashToken(token) });
    if (existing) {
      existing.name = name;
      existing.note = note;
      existing.attending = input.attending;
      await existing.save();
      return { id: existing.id, name: existing.name, note: existing.note, attending: existing.attending, replyToken: token };
    }
  }
  const replyToken = randomBytes(18).toString("hex");
  const greeting = await GreetingModel.create({
    inviteId: invite.id,
    name,
    note,
    attending: input.attending,
    replyTokenHash: hashToken(replyToken),
  });
  return { id: greeting.id, name: greeting.name, note: greeting.note, attending: greeting.attending, replyToken };
}

export async function saveMedia(token: string | undefined, file: { filename: string; mimetype: string; buffer: Buffer }) {
  const host = await hostFromToken(token);
  if (!file.buffer.length) throw new AppError(400, "That file is empty. Choose it again.");
  if (!file.mimetype.startsWith("image/") && !file.mimetype.startsWith("audio/")) {
    throw new AppError(400, "Upload a photo or an audio file.");
  }
  if (file.buffer.length > 4_500_000) throw new AppError(400, "That file is larger than 4.5 MB. Choose a smaller one.");
  const id = randomBytes(8).toString("hex");
  const ext = path.extname(file.filename).slice(0, 8) || (file.mimetype.startsWith("audio/") ? ".mp3" : ".jpg");
  const filename = `${id}${ext}`;
  await MediaModel.create({ hostId: host.id, filename, mime: file.mimetype, data: file.buffer });
  try {
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(path.join(uploadsDir, filename), file.buffer);
  } catch {
    // The database copy is what guests load. Disk storage is only a local convenience.
  }
  return { url: `/media/${filename}` };
}

export async function readMedia(filename: string) {
  if (!/^[\w.-]+$/.test(filename)) throw new AppError(400, "Bad file name.");
  const row = await MediaModel.findOne({ filename });
  if (row?.data?.length) return { mime: row.mime, body: Buffer.from(row.data) };
  const disk = path.join(uploadsDir, filename);
  try {
    await access(disk);
  } catch {
    throw new AppError(404, "That file is no longer available.");
  }
  return { mime: row?.mime || "application/octet-stream", path: disk };
}

export function mediaPath(filename: string) {
  if (!/^[\w.-]+$/.test(filename)) throw new AppError(400, "Bad file name.");
  return path.join(uploadsDir, filename);
}

function toInvite(
  invite: {
    _id: unknown;
    templateId: string;
    slug: string;
    names: string;
    title: string;
    date: string;
    createdAt?: Date;
    status?: string;
    fields?: {
      photos?: string[];
      event?: string;
      venue?: string;
      time?: string;
      receptionVenue?: string;
      receptionTime?: string;
    };
  },
  replies: number,
  yes: number,
) {
  const photos = Array.isArray(invite.fields?.photos) ? invite.fields.photos : [];
  return {
    id: String(invite._id),
    templateId: invite.templateId,
    code: invite.slug,
    status: invite.status === "draft" ? "draft" : "live",
    names: invite.names,
    title: invite.title,
    date: invite.date,
    createdAt: invite.createdAt?.toISOString() ?? new Date().toISOString(),
    replies,
    yes,
    event: invite.fields?.event ?? "",
    cover: photos[0] ?? "",
    venue: invite.fields?.venue ?? "",
    time: invite.fields?.time ?? "",
    receptionVenue: invite.fields?.receptionVenue ?? "",
    receptionTime: invite.fields?.receptionTime ?? "",
  };
}
