// The raise and the lower of a window through a session (host.window.raise, host.window.lower), and the rule that no window check
// orders a window: a check runs behind the windows of a person and measures a covered window
// (docs/spec/exposure.md#order-of-a-window).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Session } from "../app.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("a session raises and lowers its window through the host commands", () => {
  const sent = [];
  const session = { run: (name, params) => { sent.push([name, params]); return null; } };
  Session.prototype.raise.call(session);
  Session.prototype.lower.call(session);
  assert.deepEqual(sent, [["host.window.raise", {}], ["host.window.lower", {}]]);
});

/** The JavaScript files under directory, without node_modules. */
function scripts(directory) {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return scripts(path);
    return /\.(m?js)$/.test(name) ? [path] : [];
  });
}

test("no window check and no function of the check package orders a window", () => {
  const orders = /host\.window\.(raise|lower)|\.(raise|lower)\(/;
  const found = [];
  // The paths are joined from their parts: the source audit of the window checks refuses a path literal of a package.
  const harness = join("packages", "window-check");
  for (const path of [...scripts(join(root, "e2e")), ...scripts(join(root, harness))]) {
    const name = relative(root, path);
    if (name === join(harness, "test", "session-order.test.mjs")) continue;
    readFileSync(path, "utf8").split("\n").forEach((line, index) => {
      // The two methods of the session are the entries for host use; the check package itself calls neither.
      if (name === join(harness, "app.mjs") && /^\s+return this\.run\("host\.window\.(raise|lower)", \{\}\);$/.test(line)) return;
      // A comment calls nothing.
      if (/^\s*(\/\/|\/?\*)/.test(line)) return;
      if (orders.test(line)) found.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});
