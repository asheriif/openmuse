import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ɵGLOBAL_STORE } from "@copilotkit/runtime/v2";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, directory: string, token: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const config = (): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: directory,
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
});
async function signIn() {
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-rich-threads-"));
  db = await createStore();
  ({ app } = await createApp(db, config()));
  await signIn();
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function chat(threadId: string, content: string) {
  const response = await app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      threadId,
      runId: randomUUID(),
      messages: [{ id: randomUUID(), role: "user", content }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  // Reading the stream to the end waits for the run to finish.
  return response.text();
}
async function listed(): Promise<{ id: string; name: string | null; archived: boolean }[]> {
  const response = await app.request("/api/copilotkit/threads?agentId=default", {
    headers: headers(),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).threads;
}
async function saved(threadId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await db.get("system", "threads", threadId)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`thread ${threadId} was not saved`);
}

test("the main chat id is stable for the owner without a hosted thread service", async () => {
  assert.equal((await app.request("/api/main-thread")).status, 401);
  const first = await (await app.request("/api/main-thread", { headers: headers() })).json();
  const reopened = await (await app.request("/api/main-thread", { headers: headers() })).json();
  assert.equal(first.existing, true);
  assert.equal(reopened.threadId, first.threadId);
});

test("thread routes require a session", async () => {
  assert.equal((await app.request("/api/copilotkit/threads?agentId=default")).status, 401);
  for (const [path, method] of [
    ["/api/copilotkit/threads/thread-1", "PATCH"],
    ["/api/copilotkit/threads/thread-1/archive", "POST"],
  ])
    assert.equal(
      (
        await app.request(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
});

test("conversations, names and archiving are saved in the database and survive a restart", async () => {
  const threadId = randomUUID();
  await chat(threadId, "Hello there");
  await saved(threadId);
  assert.ok((await listed()).some((thread) => thread.id === threadId));

  const preflight = await app.request(`/api/copilotkit/threads/${threadId}`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:8081",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  assert.match(preflight.headers.get("Access-Control-Allow-Methods") || "", /PATCH/);
  const renamed = await app.request(`/api/copilotkit/threads/${threadId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", name: "Weekend plans" }),
  });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  const archived = await app.request(`/api/copilotkit/threads/${threadId}/archive`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ agentId: "default" }),
  });
  assert.equal(archived.status, 200);
  const history = await (
    await app.request(`/api/copilotkit/threads/${threadId}/messages`, { headers: headers() })
  ).json();
  assert.ok(
    history.messages.some((message: { content?: string }) => message.content === "Hello there"),
  );

  // A new process starts with an empty in-memory store and reloads from the database.
  ɵGLOBAL_STORE.clear();
  ({ app } = await createApp(db, config()));
  await signIn();
  const thread = (await listed()).find((item) => item.id === threadId);
  assert.deepEqual(
    { name: thread?.name, archived: thread?.archived },
    { name: "Weekend plans", archived: true },
  );
  const restored = await (
    await app.request(`/api/copilotkit/threads/${threadId}/messages`, { headers: headers() })
  ).json();
  assert.deepEqual(restored.messages, history.messages);

  const unarchived = await app.request(`/api/copilotkit/threads/${threadId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", archived: false }),
  });
  assert.equal(unarchived.status, 200);
  assert.equal((await listed()).find((item) => item.id === threadId)?.archived, false);

  // Reopening the same database in one process must not duplicate the reloaded history.
  const events = (
    await (
      await app.request(`/api/copilotkit/threads/${threadId}/events`, { headers: headers() })
    ).json()
  ).events;
  ({ app } = await createApp(db, config()));
  await signIn();
  assert.deepEqual(
    (
      await (
        await app.request(`/api/copilotkit/threads/${threadId}/events`, { headers: headers() })
      ).json()
    ).events,
    events,
  );
});

test("renaming or archiving an unknown conversation is a not-found error", async () => {
  const rename = await app.request("/api/copilotkit/threads/missing-thread", {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", name: "Nope" }),
  });
  assert.equal(rename.status, 404);
  const archive = await app.request("/api/copilotkit/threads/missing-thread/archive", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ agentId: "default" }),
  });
  assert.equal(archive.status, 404);
});

test("the runtime's clear route does not wipe saved conversations", async () => {
  const threadId = randomUUID();
  await chat(threadId, "Keep this");
  await saved(threadId);
  const response = await app.request("/api/copilotkit/threads/clear", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  assert.ok(response.status < 300);
  assert.ok((await listed()).some((thread) => thread.id === threadId));
});

test("workspace reports Rich Threads as enabled", async () => {
  const response = await app.request("/api/workspace", { headers: headers() });
  assert.equal((await response.json()).runtime.richThreads, true);
});
