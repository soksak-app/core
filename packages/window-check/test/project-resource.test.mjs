import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { Session } from "../app.mjs";
import { temporaryProject, ownProjectWindow } from "../project-resource.mjs";

for (const bodyFails of [false, true]) test(`temporary project releases its live window before removing files after ${bodyFails ? "failure" : "success"}`, { timeout: 5000 }, async () => {
  const session = new Session({ name: "resource-owner" }, {});
  const order = [];
  let live = true;
  let folder;
  session.get = async name => {
    assert.equal(name, "core.projects");
    assert.ok(existsSync(folder), "folder must survive until project detach");
    assert.equal(live, false, "child must close before project detach");
    return [{ id: "project", root: folder }];
  };
  session.run = async (name, params) => {
    assert.ok(existsSync(folder), "folder must survive project close and flush");
    if (name === "core.project.close") {
      assert.deepEqual(params, { id: "project" });
      order.push("detach");
    } else {
      assert.equal(name, "core.projects.flush");
      order.push("flush");
    }
  };
  const original = new Error("post-open input failed");
  try {
    folder = temporaryProject(session, "soksak-project-owner-");
    const child = { close: async () => { assert.ok(existsSync(folder)); live = false; order.push("close"); } };
    const close = ownProjectWindow(session, child);
    if (bodyFails) throw original;
    await close();
  } catch (error) {
    assert.equal(error, original);
  } finally {
    // This is the session's documented LIFO ownership contract.
    for (const cleanup of session.cleanups.reverse()) await cleanup();
  }
  assert.deepEqual(order, ["close", "detach", "flush"]);
  assert.equal(existsSync(folder), false);
});
