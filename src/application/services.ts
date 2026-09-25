import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findTemplate } from "../domain/catalog.js";
import { AppError } from "../domain/errors.js";
import { inviteFieldsSchema, type InviteFields } from "../domain/invite-fields.js";
import { GreetingModel, HostModel, InviteModel, MediaModel, PurchaseModel } from "../infrastructure/models.js";

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

function hostView(host: { id: string; email: string; name: string }, token: string) {
  return { token, host: { id: host.id, email: host.email, name: host.name } };
}

export async function openSession(email: string, name: string) {
  const normalized = email.trim().toLowerCase();
  const issued = issueToken();
  const existing = await HostModel.findOne({ email: normalized });
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

export async function hostFromToken(token: string | undefined) {
  if (!token) throw new AppError(401, "Sign in is required.");
  const host = await HostModel.findOne({ tokenHash: hashToken(token) });
  if (!host) throw new AppError(401, "That session is no longer valid.");
  return host;
}

export async function purchaseTemplate(token: string | undefined, templateId: string) {
  const host = await hostFromToken(token);
  const template = findTemplate(templateId);
  if (!template) throw new AppError(404, "Unknown template.");
  if (template.free) return { templateId, owned: true };
  await PurchaseModel.updateOne(
    { hostId: host.id, templateId },
    { $setOnInsert: { hostId: host.id, templateId, price: template.price } },
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
  const template = findTemplate(templateId);
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
    names: parsed.names,
    title: parsed.title,
    date: parsed.date,
    fields: parsed,
  });
  return toInvite(invite, 0, 0);
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

export async function getPublicInvite(slugValue: string) {
  const invite = await InviteModel.findOne({ slug: slugValue });
  if (!invite) throw new AppError(404, "Invitation not found.");
  return {
    slug: invite.slug,
    templateId: invite.templateId,
    fields: invite.fields,
  };
}

export async function addGreeting(slugValue: string, input: { name: string; note: string; attending: boolean }) {
  const invite = await InviteModel.findOne({ slug: slugValue });
  if (!invite) throw new AppError(404, "Invitation not found.");
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
  if (!file.mimetype.startsWith("image/") && !file.mimetype.startsWith("audio/")) {
    throw new AppError(400, "Upload a photo or an audio file.");
  }
  if (file.buffer.length > 5_000_000) throw new AppError(400, "That file is larger than 5 MB.");
  await mkdir(uploadsDir, { recursive: true });
  const id = randomBytes(8).toString("hex");
  const ext = path.extname(file.filename).slice(0, 8) || (file.mimetype.startsWith("audio/") ? ".mp3" : ".jpg");
  const filename = `${id}${ext}`;
  await writeFile(path.join(uploadsDir, filename), file.buffer);
  await MediaModel.create({ hostId: host.id, filename, mime: file.mimetype });
  return { url: `/media/${filename}` };
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
    fields?: { photos?: string[]; event?: string };
  },
  replies: number,
  yes: number,
) {
  const photos = Array.isArray(invite.fields?.photos) ? invite.fields.photos : [];
  return {
    id: String(invite._id),
    templateId: invite.templateId,
    code: invite.slug,
    names: invite.names,
    title: invite.title,
    date: invite.date,
    createdAt: invite.createdAt?.toISOString() ?? new Date().toISOString(),
    replies,
    yes,
    event: invite.fields?.event ?? "",
    cover: photos[0] ?? "",
  };
}
