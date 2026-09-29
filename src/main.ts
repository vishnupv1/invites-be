import { ensureAdmin, ensureCatalog, ensureCoupons } from "./application/services.js";
import { config } from "./config.js";
import { connectDb } from "./infrastructure/db.js";
import { buildServer } from "./interfaces/http.js";

const app = buildServer();
await connectDb();
await ensureAdmin();
await ensureCatalog();
await ensureCoupons();
await app.listen({ port: config.port, host: "0.0.0.0" });
