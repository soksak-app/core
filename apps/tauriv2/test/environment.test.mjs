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
  // release 번들은 soksak 이름과 release 식별자를 쓰고, 디버그 build 가 식별자와 이름을 바꾼다. 호스트는 command line
  // package 의 식별자로 기본 설정 디렉터리를 정하고, macOS 는 번들 식별자로 알림 권한을 구분한다.
  const conf = JSON.parse(readFileSync(new URL("../tauri.conf.json", import.meta.url), "utf8"));
  const plist = readFileSync(new URL("../platform/darwin/Info.plist", import.meta.url), "utf8");
  const value = (key) => plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
  assert.equal(conf.identifier, "app.soksak.tauri");
  assert.equal(value("CFBundleIdentifier"), "app.soksak.tauri");
  assert.equal(value("CFBundleName"), "soksak");
  assert.equal(value("CFBundleDisplayName"), "soksak");
  assert.equal(value("CFBundleExecutable"), "soksak-tauriv2");
});
