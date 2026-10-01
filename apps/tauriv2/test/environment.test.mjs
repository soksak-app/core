import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { checkReferences, validateEnvironment, validateManifest } from "@soksak/plugin-api";

const require = createRequire(import.meta.url);
const environment = JSON.parse(readFileSync(new URL("../environment.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("environment.json satisfies the environment format and names a runtime module", () => {
  assert.equal(validateEnvironment(environment), environment);
  assert.ok(existsSync(new URL(`../${environment.runtime}/index.js`, import.meta.url)));
});

test("every plugin is a declared dependency and every reference resolves", () => {
  const manifests = environment.plugins.map((name) => {
    assert.ok(pkg.dependencies[name], `${name} is not a dependency`);
    return validateManifest(require(`${name}/plugin.json`));
  });
  checkReferences(environment, manifests);
});

test("the bundle identifier and the Tauri identifier are the application identifier of docs/spec/hosts.md", () => {
  // Tauri 는 identifier 로 기본 설정 디렉터리를 정하고, macOS 는 번들 식별자로 알림 권한을 구분한다. 둘이 다르면 같은 앱의 데이터와 권한이 갈라진다.
  const conf = JSON.parse(readFileSync(new URL("../tauri.conf.json", import.meta.url), "utf8"));
  const plist = readFileSync(new URL("../platform/darwin/Info.plist", import.meta.url), "utf8");
  const bundle = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.equal(conf.identifier, "com.soksak.tauri");
  assert.equal(bundle, "com.soksak.tauri");
});
