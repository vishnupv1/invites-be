import assert from "node:assert/strict";
import test from "node:test";

const API = process.env.API_URL || "http://127.0.0.1:4010";
const stamp = Date.now();
const password = "local-regression-pass-1";

async function call(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

const fields = {
  event: "marriage",
  hosts: "QA families",
  names: "QA One & QA Two",
  title: "We joyfully invite you to the celebration of our children",
  detail: "",
  date: "2026-12-12",
  time: "16:00",
  venue: "Hall",
  address: "",
  message: "",
  dress: "",
  rsvpBy: "",
  hostEmail: "",
  receptionTime: "",
  receptionVenue: "",
  receptionAddress: "",
  photos: [],
  notes: "",
  audio: "",
  lat: "",
  lng: "",
  lines: "",
  canvas: "",
};

test("passwordless session is issued once and cannot be taken over by email", async () => {
  const email = `qa.session.${stamp}@example.com`;
  const first = await call("/api/session", { method: "POST", body: { email, name: "First" } });
  assert.equal(first.status, 200);
  assert.equal(typeof first.payload.token, "string");
  const second = await call("/api/session", { method: "POST", body: { email, name: "Second" } });
  assert.equal(second.status, 401);
  const still = await call("/api/session", { token: first.payload.token });
  assert.equal(still.status, 200);
  assert.equal(still.payload.name, "First");
});

test("a password account cannot be opened from email alone", async () => {
  const email = `qa.password.${stamp}@example.com`;
  const created = await call("/api/auth/signup", {
    method: "POST",
    body: { name: "QA Host", email, password },
  });
  assert.equal(created.status, 200);
  const stolen = await call("/api/session", { method: "POST", body: { email, name: "Other" } });
  assert.equal(stolen.status, 401);
  const session = await call("/api/session", { token: created.payload.token });
  assert.equal(session.status, 200);
  assert.equal(session.payload.email, email);
});

test("changing an RSVP updates the same reply", async () => {
  const email = `qa.rsvp.${stamp}@example.com`;
  const created = await call("/api/auth/signup", {
    method: "POST",
    body: { name: "QA Host", email, password },
  });
  assert.equal(created.status, 200);
  const invite = await call("/api/invites", {
    method: "POST",
    token: created.payload.token,
    body: { templateId: "gazal", fields },
  });
  assert.equal(invite.status, 200);
  const slug = invite.payload.code || invite.payload.slug;
  assert.equal(typeof slug, "string");
  const first = await call(`/api/invites/${slug}/greetings`, {
    method: "POST",
    body: { name: "QA Guest", note: "First wish", attending: true },
  });
  assert.equal(first.status, 200);
  assert.equal(typeof first.payload.replyToken, "string");
  const second = await call(`/api/invites/${slug}/greetings`, {
    method: "POST",
    body: { name: "QA Guest", note: "Updated wish", attending: false, replyToken: first.payload.replyToken },
  });
  assert.equal(second.status, 200);
  assert.equal(second.payload.id, first.payload.id);
  const rows = await call(`/api/invites/${slug}/greetings`, { token: created.payload.token });
  assert.equal(rows.status, 200);
  assert.equal(rows.payload.length, 1);
  assert.equal(rows.payload[0].note, "Updated wish");
  assert.equal(rows.payload[0].attending, false);
});

test("publishing a paid template without a purchase is refused", async () => {
  const email = `qa.paywall.${stamp}@example.com`;
  const created = await call("/api/auth/signup", {
    method: "POST",
    body: { name: "QA Host", email, password },
  });
  assert.equal(created.status, 200);
  const draft = await call("/api/invites/draft", {
    method: "POST",
    token: created.payload.token,
    body: { templateId: "shaadi", fields },
  });
  assert.equal(draft.status, 200);
  const published = await call(`/api/invites/record/${draft.payload.id}/publish`, {
    method: "POST",
    token: created.payload.token,
  });
  assert.equal(published.status, 402);
  const direct = await call("/api/invites", {
    method: "POST",
    token: created.payload.token,
    body: { templateId: "shaadi", fields },
  });
  assert.equal(direct.status, 402);
});
