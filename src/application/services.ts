import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import catalogSeedFile from "../infrastructure/catalog-seed.json" with { type: "json" };
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import Razorpay from "razorpay";
import { config } from "../config.js";
import { AppError } from "../domain/errors.js";
import { draftFieldsSchema, editorStateSchema, inviteFieldsSchema, type EditorState, type InviteFields } from "../domain/invite-fields.js";
import { CouponModel, EventModel, GreetingModel, HostModel, InviteModel, MediaModel, PurchaseModel, TemplateModel } from "../infrastructure/models.js";

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

export async function openSession(email: string, name: string) {
  const normalized = email.trim().toLowerCase();
  const issued = issueToken();
  const existing = await HostModel.findOne({ email: normalized });
  if (existing?.passwordHash) {
    throw new AppError(401, "Log in to use that email.");
  }
  if (existing) {
    existing.name = name.trim() || existing.name;
    existing.tokenHash = issued.tokenHash;
    await existing.save();
    return hostView(existing, issued.token);
  }
  const host = await HostModel.create({
    email: normalized,
    name: name.trim() || "Host",
    tokenHash: issued.tokenHash,
  });
  return hostView(host, issued.token);
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
  await CouponModel.updateOne({ code: "WELCOME26" }, { $setOnInsert: { code: "WELCOME26", active: true } }, { upsert: true });
}

export async function verifyCoupon(code: string) {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new AppError(400, "Enter a coupon code.");
  const coupon = await CouponModel.findOne({ code: normalized }).lean();
  if (!coupon || coupon.active === false) throw new AppError(400, "That coupon code is not valid.");
  return { valid: true as const, code: coupon.code };
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

export async function createPaymentOrder(token: string | undefined, templateId: string) {
  const host = await hostFromToken(token);
  const template = await getCatalogTemplate(templateId);
  if (!template) throw new AppError(404, "Unknown template.");
  if (template.free) throw new AppError(400, "This template is free.");
  if (await PurchaseModel.exists({ hostId: host.id, templateId })) {
    throw new AppError(409, "You already own this template.");
  }
  const amount = Math.round(template.price * 100);
  if (!Number.isSafeInteger(amount) || amount < 100) {
    throw new AppError(400, "Payment amount must be at least ₹1.");
  }
  let order;
  try {
    order = await razorpayClient().orders.create({
      amount,
      currency: "INR",
      receipt: `p_${Date.now()}_${randomBytes(4).toString("hex")}`,
      notes: { hostId: String(host.id), templateId },
    });
  } catch (error) {
    throwRazorpayError(error);
  }
  return {
    keyId: config.razorpayKeyId,
    orderId: order.id,
    amount: Number(order.amount),
    currency: order.currency,
  };
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
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    throw new AppError(400, "Razorpay could not verify that payment.");
  }
  const order = await razorpayClient().orders.fetch(payment.razorpay_order_id);
  if (order.status !== "paid" || String(order.notes?.hostId ?? "") !== String(host.id)) {
    throw new AppError(400, "That payment does not match this purchase.");
  }
  return { host, order };
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
  const verified = coupon?.trim() ? await verifyCoupon(coupon) : null;
  if (!verified) {
    if (!payment) throw new AppError(402, "Complete the payment to unlock this template.");
    const { order } = await verifyPaymentProof(token, payment);
    const notes = order.notes ?? {};
    if (
      Number(order.amount) !== Math.round(template.price * 100) ||
      order.currency !== "INR" ||
      String(notes.templateId ?? "") !== templateId
    ) {
      throw new AppError(400, "That payment does not match this purchase.");
    }
  }
  await PurchaseModel.updateOne(
    { hostId: host.id, templateId },
    {
      $setOnInsert: {
        hostId: host.id,
        templateId,
        price: verified ? 0 : template.price,
        coupon: verified?.code ?? "",
        ...(!verified && payment
          ? {
              razorpayOrderId: payment.razorpay_order_id,
              razorpayPaymentId: payment.razorpay_payment_id,
            }
          : {}),
      },
    },
    { upsert: true },
  );
  return { templateId, owned: true };
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
  if (!owned) throw new AppError(402, "Buy this template once before publishing.");
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
  return {
    slug: invite.slug,
    templateId: invite.templateId,
    fields: invite.fields,
    greetings: greetings
      .filter((row) => row.note.trim())
      .map((row) => ({ name: row.name, note: row.note })),
  };
}

export async function addGreeting(slugValue: string, input: { name: string; note: string; attending: boolean }) {
  const invite = await InviteModel.findOne({ slug: slugValue });
  if (!invite || invite.status === "draft") throw new AppError(404, "Invitation not found.");
  const greeting = await GreetingModel.create({
    inviteId: invite.id,
    name: input.name.trim(),
    note: input.note.trim(),
    attending: input.attending,
  });
  return { id: greeting.id, name: greeting.name, note: greeting.note, attending: greeting.attending };
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
