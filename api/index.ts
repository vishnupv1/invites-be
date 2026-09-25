import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureAdmin, ensureCatalog } from "../src/application/services.js";
import { connectDb } from "../src/infrastructure/db.js";
import { buildServer } from "../src/interfaces/http.js";

const app = buildServer();
let ready: Promise<void> | undefined;

function prepare() {
  ready ??= (async () => {
    await connectDb();
    await ensureAdmin();
    await ensureCatalog();
    await app.ready();
  })();
  return ready;
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  await prepare();
  app.server.emit("request", request, response);
}
