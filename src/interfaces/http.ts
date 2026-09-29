import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { addGreeting, adminSummary, createInvite, getCatalogTemplate, getOwnInvite, getPublicInvite, hostFromToken, listEvents, listGreetings, listInvites, listPurchases, listTemplates, logIn, openSession, publishInvite, purchaseTemplate, readMedia, saveInvite, saveMedia, signUp, verifyCoupon } from "../application/services.js";
import { config } from "../config.js";
import { AppError } from "../domain/errors.js";
import { draftFieldsSchema, editorStateSchema, inviteFieldsSchema } from "../domain/invite-fields.js";

function bearer(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

export function buildServer() {
  const app = Fastify({ logger: true });
  app.register(cors, {
    origin: config.corsOrigin,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });
  app.register(multipart, { limits: { fileSize: 4_500_000 } });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.status(400).send({ error: "Check those details." });
    const code = "code" in error ? String(error.code) : "";
    if (code === "FST_REQ_FILE_TOO_LARGE" || error.statusCode === 413) {
      return reply.status(413).send({ error: "That file is larger than 4.5 MB. Choose a smaller one." });
    }
    if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE" || code === "FST_NO_FORM_DATA") {
      return reply.status(400).send({ error: "Choose a photo or an audio file." });
    }
    app.log.error(error);
    return reply.status(500).send({ error: "Could not finish that. Try again." });
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/events", async () => listEvents());

  app.get("/api/templates", async () => listTemplates());

  app.get("/api/templates/:id", async (request) => {
    const { id } = request.params as { id: string };
    const template = await getCatalogTemplate(id);
    if (!template) throw new AppError(404, "Unknown template.");
    return template;
  });

  app.get("/api/admin/summary", async (request) => adminSummary(bearer(request.headers.authorization)));

  app.post("/api/auth/signup", async (request) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        email: z.string().email(),
        password: z.string().min(8).max(200),
      })
      .parse(request.body);
    return signUp(body.name, body.email, body.password);
  });

  app.post("/api/auth/login", async (request) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1).max(200),
      })
      .parse(request.body);
    return logIn(body.email, body.password);
  });

  app.post("/api/session", async (request) => {
    const body = z.object({ email: z.string().email(), name: z.string().min(1).max(120) }).parse(request.body);
    return openSession(body.email, body.name);
  });

  app.get("/api/session", async (request) => {
    const host = await hostFromToken(bearer(request.headers.authorization));
    return { id: host.id, email: host.email, name: host.name };
  });

  app.post("/api/coupons/verify", async (request) => {
    const body = z.object({ code: z.string().max(40) }).parse(request.body);
    return verifyCoupon(body.code);
  });

  app.get("/api/purchases", async (request) => listPurchases(bearer(request.headers.authorization)));

  app.post("/api/purchases", async (request) => {
    const body = z.object({ templateId: z.string(), coupon: z.string().max(40).optional() }).parse(request.body);
    return purchaseTemplate(bearer(request.headers.authorization), body.templateId, body.coupon);
  });

  app.get("/api/invites", async (request) => listInvites(bearer(request.headers.authorization)));

  app.post("/api/invites", async (request) => {
    const body = z.object({ templateId: z.string(), fields: inviteFieldsSchema }).parse(request.body);
    return createInvite(bearer(request.headers.authorization), body.templateId, body.fields);
  });

  app.post("/api/invites/draft", async (request) => {
    const body = z
      .object({
        templateId: z.string(),
        fields: draftFieldsSchema,
        editor: editorStateSchema.optional(),
      })
      .parse(request.body);
    return saveInvite(bearer(request.headers.authorization), body);
  });

  app.get("/api/invites/record/:id", async (request) => {
    const { id } = request.params as { id: string };
    return getOwnInvite(bearer(request.headers.authorization), id);
  });

  app.put("/api/invites/record/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        templateId: z.string(),
        fields: draftFieldsSchema,
        editor: editorStateSchema.optional(),
      })
      .parse(request.body);
    return saveInvite(bearer(request.headers.authorization), { ...body, id });
  });

  app.post("/api/invites/record/:id/publish", async (request) => {
    const { id } = request.params as { id: string };
    return publishInvite(bearer(request.headers.authorization), id);
  });

  app.get("/api/invites/:slug/greetings", async (request) => {
    const { slug } = request.params as { slug: string };
    return listGreetings(bearer(request.headers.authorization), slug);
  });

  app.get("/api/invites/:slug", async (request) => {
    const { slug } = request.params as { slug: string };
    return getPublicInvite(slug);
  });

  app.post("/api/invites/:slug/greetings", async (request) => {
    const { slug } = request.params as { slug: string };
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        note: z.string().max(1000).default(""),
        attending: z.boolean().default(true),
      })
      .parse(request.body);
    return addGreeting(slug, body);
  });

  app.post("/api/media", async (request) => {
    const file = await request.file();
    if (!file) throw new AppError(400, "Choose a file.");
    const buffer = await file.toBuffer();
    return saveMedia(bearer(request.headers.authorization), {
      filename: file.filename,
      mimetype: file.mimetype,
      buffer,
    });
  });

  app.get("/media/:filename", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const file = await readMedia(filename);
    reply.type(file.mime);
    if ("body" in file) return reply.send(file.body);
    return reply.send(createReadStream(file.path));
  });

  return app;
}
