import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const envFile = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function normalizeOrigin(value: string) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed || trimmed === "*" || trimmed === "true") return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

const defaultOrigins = [
  "https://invitesready.com",
  "https://www.invitesready.com",
  "https://invites-phi-mauve.vercel.app",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
];

const corsOrigins = [
  ...new Set([
    ...defaultOrigins,
    ...(process.env.CORS_ORIGIN ?? "").split(",").map(normalizeOrigin).filter(Boolean),
  ]),
];

export const config = {
  port: Number(process.env.PORT ?? 4010),
  mongoUri: process.env.MONGODB_OG_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/vellum",
  corsOrigin: corsOrigins,
  adminEmail: (process.env.ADMIN_EMAIL ?? "admin@invitesready.com").trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD ?? "12345",
  adminEmails: (process.env.ADMIN_EMAILS ?? process.env.ADMIN_EMAIL ?? "admin@invitesready.com")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
};
