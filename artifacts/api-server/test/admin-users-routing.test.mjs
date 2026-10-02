import assert from "node:assert/strict";
import { after, test } from "node:test";
import express from "express";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const compiledDir = await mkdtemp(join(tmpdir(), "event-system-admin-router-"));
const compiledModule = join(compiledDir, "admin-users.cjs");
await build({
  entryPoints: [new URL("../src/routes/admin-users.ts", import.meta.url).pathname],
  outfile: compiledModule,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const compiledExports = await import(pathToFileURL(compiledModule).href);
const adminUsersRouter = compiledExports.default.default ?? compiledExports.default;

after(async () => {
  await rm(compiledDir, { recursive: true, force: true });
});

test("regular users can reach workspace routes while admin account routes remain protected", async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.authUser = { id: "regular-user", username: "member", role: "user" };
    next();
  });
  app.use("/api", adminUsersRouter);
  app.get("/api/dashboard", (_req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/api`;

    const dashboardResponse = await fetch(`${baseUrl}/dashboard`);
    assert.equal(dashboardResponse.status, 200);
    assert.deepEqual(await dashboardResponse.json(), { ok: true });

    const adminResponse = await fetch(`${baseUrl}/admin/users`);
    assert.equal(adminResponse.status, 403);
    assert.equal(adminResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await adminResponse.json(), {
      error: "Administrator access is required.",
    });
  } finally {
    server.close();
  }
});