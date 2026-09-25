import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { addGreeting, adminSummary, createInvite, getCatalogTemplate, getPublicInvite, hostFromToken, listEvents, listGreetings, listInvites, listPurchases, listTemplates, logIn, mediaPath, openSession, purchaseTemplate, saveMedia, signUp } from "../application/services.js";
import { config } from "../config.js";
import { AppError } from "../domain/errors.js";
import { inviteFieldsSchema } from "../domain/invite-fields.js";

function bearer(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

export function buildServer() {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: config.corsOrigin });
  app.register(multipart, { limits: { fileSize: 5_000_000 } });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.status(400).send({ error: "Check those details." });
    app.log.error(error);
    return reply.status(500).send({ error: "Something went wrong." });
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

  app.get("/api/purchases", async (request) => listPurchases(bearer(request.headers.authorization)));

  app.post("/api/purchases", async (request) => {
    const body = z.object({ templateId: z.string() }).parse(request.body);
    return purchaseTemplate(bearer(request.headers.authorization), body.templateId);
  });

  app.get("/api/invites", async (request) => listInvites(bearer(request.headers.authorization)));

  app.post("/api/invites", async (request) => {
    const body = z.object({ templateId: z.string(), fields: inviteFieldsSchema }).parse(request.body);
    return createInvite(bearer(request.headers.authorization), body.templateId, body.fields);
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
    return reply.send(createReadStream(mediaPath(filename)));
  });

  return app;
}
