export const config = {
  port: Number(process.env.PORT ?? 4010),
  mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/vellum",
  corsOrigin: process.env.CORS_ORIGIN ?? true,
  adminEmail: (process.env.ADMIN_EMAIL ?? "admin@invitesready.com").trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD ?? "12345",
  adminEmails: (process.env.ADMIN_EMAILS ?? process.env.ADMIN_EMAIL ?? "admin@invitesready.com")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
};
