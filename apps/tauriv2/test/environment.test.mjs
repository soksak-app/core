import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { validateEnvironment } from "@soksak/plugin-api";

const environment = JSON.parse(readFileSync(new URL("../environment.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("environment.json satisfies the environment format and names a runtime module", () => {
  assert.equal(validateEnvironment(environment), environment);
  assert.ok(existsSync(new URL(`../${environment.runtime}/index.js`, import.meta.url)));
});

test("the environment lists no plugins; the configuration directory installs them", () => {
  assert.equal(environment.plugins, undefined);
  assert.deepEqual(Object.keys(pkg.dependencies).filter((name) => name.startsWith("@soksak/plugin-")), []);
});

test("the bundle and the Tauri configuration declare the release identity of docs/spec/hosts.md", () => {
  // The release bundle uses the soksak name and the release identifier, and a debug build changes the identifier and the name. The host sets the default settings directory from the command line
  // package identifier, and on macOS it distinguishes the notification permission by the bundle identifier.
  const conf = JSON.parse(readFileSync(new URL("../tauri.conf.json", import.meta.url), "utf8"));
  const plist = readFileSync(new URL("../platform/darwin/Info.plist", import.meta.url), "utf8");
  const value = (key) => plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
  assert.equal(conf.identifier, "app.soksak.tauri");
  assert.equal(value("CFBundleIdentifier"), "app.soksak.tauri");
  assert.equal(value("CFBundleName"), "soksak");
  assert.equal(value("CFBundleDisplayName"), "soksak");
  assert.equal(value("CFBundleExecutable"), "soksak-tauriv2");
});
