// The declared UI snapshot ingress has no native transport in a page without a host bridge.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

mock.module("@soksak/runtime", { namedExports: { host: null, page: null } });

const { afterDeclaredSnapshotIngress, createDeclaredSource, startDeclaredSnapshotIngress } = await import("../declared-source.js");

test("a page without a native bridge starts ingress without a fallback transport", async () => {
  let started = false;
  await afterDeclaredSnapshotIngress(() => { started = true; });
  await startDeclaredSnapshotIngress();
  assert.equal(started, true, "provider startup did not pass the no-host readiness boundary");

  const channel = createDeclaredSource({ plugin: "demo", status: "tree" }).channel({ id: "view-a", surface: "view-a" });
  const unsubscribe = await channel.onMessage(() => {});
  assert.equal(typeof unsubscribe, "function", "the no-host channel did not return recipient cleanup");
  unsubscribe();
});
