// 공개 registry 를 https 로 읽는 plugin 작업을 검사 소유 TLS registry 로 검사한다(docs/spec/installation.md 의 Fetching).
//
// check 애플리케이션은 진단 build 이고 `make e2e-registry-tls` 가 만든 인증 기관으로 시작되어 있어야 한다:
// `--registry-ca <root>/soksak-check-registry-tls/ca.pem`(docs/operations/examples.md). 검사는 workspace registry
// (`make install-plugins` 가 만든 target/registry)를 https 로 제공하고, 끝나면 원래 registry 와 설치를 되돌린다.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, fresh, keepCommonSettings, open } from "./app.mjs";

const TLS = join(process.env.SOKSAK_CONFIG_ROOT ?? tmpdir(), "soksak-check-registry-tls");
const REGISTRY = fileURLToPath(new URL("../target/registry/", import.meta.url));

/** 검사 소유 TLS registry. index 변형마다 경로가 있고, archive 는 /archives/<file> 로 제공한다. */
async function serveRegistry() {
  for (const file of ["server.pem", "server-key.pem", "ca.pem"]) {
    if (!existsSync(join(TLS, file))) throw new Error(`${join(TLS, file)} is missing; run make e2e-registry-tls and start the check applications with --registry-ca ${join(TLS, "ca.pem")}`);
  }
  if (!existsSync(join(REGISTRY, "index.json"))) throw new Error(`${join(REGISTRY, "index.json")} is missing; run make install-plugins for the check configuration`);
  const original = JSON.parse(readFileSync(join(REGISTRY, "index.json"), "utf8"));
  const prefix = pathToFileURL(REGISTRY).href;
  const server = createServer({ cert: readFileSync(join(TLS, "server.pem")), key: readFileSync(join(TLS, "server-key.pem")) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `https://127.0.0.1:${server.address().port}`;
  // archive 의 file: 주소를 이 server 의 주소로 바꾼다. sha256 은 같은 파일이므로 그대로다.
  const index = JSON.parse(JSON.stringify(original).replaceAll(prefix, `${base}/archives/`));
  const browser = index.plugins.find((plugin) => plugin.id === "browser");
  const version = browser.versions.at(-1).version;
  const badHash = structuredClone(index);
  badHash.plugins.find((plugin) => plugin.id === "browser").versions.at(-1).package.sha256 = "0".repeat(64);
  const revoked = structuredClone(index);
  revoked.revoked.plugins.push({ id: "browser", version, reason: "registry window check" });
  const documents = { "/good/index.json": index, "/bad-hash/index.json": badHash, "/revoked/index.json": revoked };
  server.on("request", (request, response) => {
    if (documents[request.url]) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(documents[request.url]));
      return;
    }
    const archive = request.url.startsWith("/archives/") ? join(REGISTRY, decodeURIComponent(request.url.slice("/archives/".length))) : null;
    if (archive && !archive.includes("..") && existsSync(archive)) {
      response.writeHead(200);
      response.end(readFileSync(archive));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return { base, version, close: () => new Promise((resolve) => server.close(resolve)) };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: plugin operations read an https registry and refuse a wrong hash, a revoked version and an unreachable registry`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const before = await s.get("core.plugins");
    const registry = await serveRegistry();
    // 검사가 중간에 실패해도 다음 검사가 같은 registry 와 설치에서 시작하게 되돌린다. 정리는 등록의 역순이다.
    s.cleanup(registry.close);
    s.cleanup(async () => {
      await s.run("core.plugins.registry", { index: before.registry });
      const now = await s.get("core.plugins");
      if (!now.plugins.find((row) => row.id === "browser")?.installed) await s.run("core.plugins.install", { plugin: "browser" });
    });
    const use = async (path) => {
      const index = `${registry.base}${path}`;
      await s.run("core.plugins.registry", { index });
      return s.until("core.plugins", (value) => value.registry === index && value.error === null, `the registry did not change to ${index}`);
    };
    const remove = async () => {
      await s.run("core.plugins.remove", { plugin: "browser" });
      await s.until("core.plugins", (value) => value.operation?.action === "remove" && value.operation.state === "done"
        && !value.plugins.find((row) => row.id === "browser")?.installed, "browser was not removed");
    };

    await use("/good/index.json");
    await remove();
    await s.run("core.plugins.install", { plugin: "browser" });
    const installed = await s.until("core.plugins", (value) => value.operation?.action === "install" && value.operation.state === "done",
      "browser was not installed from the https registry");
    assert.equal(installed.plugins.find((row) => row.id === "browser").installed.version, registry.version);

    await use("/bad-hash/index.json");
    await remove();
    await assert.rejects(s.run("core.plugins.install", { plugin: "browser" }), /has sha256 [0-9a-f]{64}, the entry says 0{64}/);
    await use("/revoked/index.json");
    await assert.rejects(s.run("core.plugins.install", { plugin: "browser" }), /plugin browser has no version for core /);
    await use("/good/index.json");
    await s.run("core.plugins.install", { plugin: "browser" });
    await s.until("core.plugins", (value) => value.operation?.action === "install" && value.operation.state === "done"
      && value.plugins.find((row) => row.id === "browser")?.installed, "browser was not installed again");

    // 닿지 않는 registry 는 그 주소와 연결 실패를 밝히고, 지금의 registry 를 바꾸지 않는다.
    const closed = `${registry.base}/good/index.json`;
    await registry.close();
    await assert.rejects(s.run("core.plugins.registry", { index: closed }), /cannot connect/);
  });
}
