// The main page checks a sidecar request of a plugin host before it sends it (docs/plans/plugin-host-routes.md rule 8).
// The fixtures use the names probe and fixture-* only: core names no real plugin or sidecar.
import test from "node:test";
import assert from "node:assert/strict";
import { checkHostSidecarRequest } from "../plugin-host.js";

const message = { form: "json-object", operationField: "operation" };
const sidecar = { executable: "build/worker", protocol: 1, message, hostReadOperations: ["list", "stat"] };
const declared = ["list"];

test("a declared read operation is forwarded as the re-serialized object", () => {
  const body = '{ "operation": "list", "path": "a" }';
  assert.equal(checkHostSidecarRequest({ plugin: "probe", sidecar: "fixture-sidecar", declared, sidecarDeclaration: sidecar, body }),
    '{"operation":"list","path":"a"}');
});

test("an operation that the manifest does not declare is refused by name", () => {
  const body = '{"operation":"stat"}';
  assert.throws(() => checkHostSidecarRequest({ plugin: "probe", sidecar: "fixture-sidecar", declared, sidecarDeclaration: sidecar, body }),
    { message: "plugin host probe: operation stat is not served" });
});

test("an operation that the sidecar does not allow a host is refused even if declared", () => {
  const body = '{"operation":"write"}';
  const sidecarDeclaration = { ...sidecar, hostReadOperations: ["list"] };
  assert.throws(() => checkHostSidecarRequest({ plugin: "probe", sidecar: "fixture-sidecar", declared: ["list", "write"], sidecarDeclaration, body }),
    { message: "plugin host probe: operation write is not served" });
});

test("a sidecar without a declared message form serves no operation", () => {
  const sidecarDeclaration = { executable: "build/worker", protocol: 1, hostReadOperations: ["list"] };
  assert.throws(() => checkHostSidecarRequest({ plugin: "probe", sidecar: "fixture-sidecar", declared, sidecarDeclaration, body: '{"operation":"list"}' }),
    { message: "plugin host probe: sidecar fixture-sidecar declares no message form" });
});

test("a body that is not an object or has no string operation field is refused", () => {
  const check = (body) => () => checkHostSidecarRequest({ plugin: "probe", sidecar: "fixture-sidecar", declared, sidecarDeclaration: sidecar, body });
  assert.throws(check("[1]"), { message: "plugin host probe: body is not a JSON object" });
  assert.throws(check("null"), { message: "plugin host probe: body is not a JSON object" });
  assert.throws(check("not json"), { message: "plugin host probe: body is not a JSON object" });
  assert.throws(check('{"path":"a"}'), { message: "plugin host probe: operation is missing or not a string" });
  assert.throws(check('{"operation":3}'), { message: "plugin host probe: operation is missing or not a string" });
});

test("the message form names the operation field, so a sidecar may use another name", () => {
  const sidecarDeclaration = { ...sidecar, message: { form: "json-object", operationField: "op" } };
  assert.equal(checkHostSidecarRequest({ plugin: "probe", sidecar: "fixture-sidecar", declared, sidecarDeclaration, body: '{"op":"list"}' }),
    '{"op":"list"}');
});
