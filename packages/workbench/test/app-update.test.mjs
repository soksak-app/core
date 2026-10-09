// The application update state and operation of the plugin screen (docs/spec/installation.md#application-update).
import test from "node:test";
import assert from "node:assert/strict";
import { createAppUpdate, releasePage } from "../app-update.js";

const available = {
  version: "0.0.9",
  release: { url: "https://github.com/soksak-app/core/releases/download/v0.0.9/soksak-0.0.9-darwin-arm64-wailsv3.zip", sha256: "0".repeat(64) },
};

/** A host whose calls are answered by `replies` and recorded in `calls`. */
function fakeHost(replies) {
  const calls = [];
  return {
    calls,
    async call(name, params) {
      calls.push([name, params ?? null]);
      const reply = replies[name];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

test("the release page of a version is derived from the release URL of a published release only", () => {
  assert.equal(releasePage(available.release.url), "https://github.com/soksak-app/core/releases/tag/v0.0.9");
  assert.equal(releasePage("file:///releases/soksak-0.0.9.zip"), null);
  assert.equal(releasePage("https://example.org/files/soksak-0.0.9.zip"), null);
});

test("the status names the running version, the candidate with its release page and no operation", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.8", available } });
  let changes = 0;
  const update = createAppUpdate({ host, changed: () => { changes += 1; } });
  assert.deepEqual(update.status(), { version: null, available: null, operation: null, error: null });
  await update.refresh();
  assert.deepEqual(update.status(), {
    version: "0.0.8",
    available: { version: "0.0.9", release: "https://github.com/soksak-app/core/releases/tag/v0.0.9" },
    operation: null,
    error: null,
  });
  assert.equal(changes, 1);
});

test("a state that cannot be read is the error of the status and leaves no candidate", async () => {
  const host = fakeHost({ appUpdateState: new Error("registry: unreachable") });
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  assert.deepEqual(update.status(), { version: null, available: null, operation: null, error: "registry: unreachable" });
});

test("updating stages the candidate, then applies the staged bundle, and reports each step", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.8", available }, appUpdateStage: { bundle: "/config/updates/0.0.9/soksak.app" }, appUpdateApply: null });
  const steps = [];
  const update = createAppUpdate({ host, changed: () => { steps.push(update.status().operation?.state ?? null); } });
  await update.refresh();
  await update.update();
  assert.deepEqual(host.calls.slice(1), [
    ["appUpdateStage", { version: "0.0.9" }],
    ["appUpdateApply", { bundle: "/config/updates/0.0.9/soksak.app" }],
  ]);
  assert.deepEqual(steps, [null, "staging", "applying"]);
});

test("a failed step is the error of the operation and stops the update", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.8", available }, appUpdateStage: new Error("application update: sha256 differs"), appUpdateApply: null });
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await assert.rejects(update.update(), /sha256 differs/);
  assert.deepEqual(update.status().operation, { state: "failed", version: "0.0.9", error: "application update: sha256 differs" });
  assert.equal(host.calls.some(([name]) => name === "appUpdateApply"), false);
});

test("updating without a candidate fails before any host call", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.9", available: null } });
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await assert.rejects(update.update(), /no application update is available/);
  assert.equal(host.calls.length, 1);
});

test("opening the release page asks the host to open the page of the candidate and fails without one", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.8", available }, linkOpen: null });
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await update.openRelease();
  assert.deepEqual(host.calls.at(-1), ["linkOpen", { url: "https://github.com/soksak-app/core/releases/tag/v0.0.9" }]);
  const local = fakeHost({ appUpdateState: { version: "0.0.8", available: { ...available, release: { ...available.release, url: "file:///releases/soksak.zip" } } } });
  const other = createAppUpdate({ host: local, changed: () => {} });
  await other.refresh();
  await assert.rejects(other.openRelease(), /no release page/);
});
