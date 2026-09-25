import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findTemplate } from "../domain/catalog.js";
import { AppError } from "../domain/errors.js";
import { inviteFieldsSchema, type InviteFields } from "../domain/invite-fields.js";
import { GreetingModel, HostModel, InviteModel, MediaModel, PurchaseModel } from "../infrastructure/models.js";

const uploadsDir = path.resolve(process.cwd(), "uploads");

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function slug() {
  return randomBytes(6).toString("base64url");
}

export async function openSession(email: string, name: string) {
  const normalized = email.trim().toLowerCase();
  const token = randomBytes(24).toString("hex");
  const tokenHash = hashToken(token);
  const existing = await HostModel.findOne({ email: normalized });
  if (existing) {
    existing.name = name.trim() || existing.name;
    existing.tokenHash = tokenHash;
    await existing.save();
    return { token, host: { id: existing.id, email: existing.email, name: existing.name } };
  }
  const host = await HostModel.create({ email: normalized, name: name.trim() || "Host", tokenHash });
  return { token, host: { id: host.id, email: host.email, name: host.name } };
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
  invite: { _id: unknown; templateId: string; slug: string; names: string; title: string; date: string; createdAt?: Date },
  replies: number,
  yes: number,
) {
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
  };
}
