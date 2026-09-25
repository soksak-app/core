import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { validateManifest } from "@soksak/plugin-api";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("plugin.json satisfies the manifest format", () => {
  assert.equal(validateManifest(manifest), manifest);
});

test("the package publishes the manifest and surface module", () => {
  assert.ok(pkg.files.includes("plugin.json"));
  if (manifest.surface?.module === undefined) return;
  assert.ok(existsSync(new URL(`../${manifest.surface.module}`, import.meta.url)), manifest.surface.module);
  assert.ok(pkg.files.some((entry) => manifest.surface.module === entry || manifest.surface.module.startsWith(`${entry}/`)));
});

test("every sidecar the plugin uses is a declared package dependency", () => {
  for (const name of manifest.sidecars ?? []) {
    assert.ok(pkg.dependencies?.[name], `${name} is not a dependency`);
  }
});

test("every section module is published and draws a list that dispose removes", async () => {
  // 섹션 모듈이 쓰는 문서 기능만 흉내 낸다.
  const element = () => ({ children: [], textContent: "", className: "", parent: null,
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } },
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); } });
  globalThis.document = { createElement: element };
  for (const section of manifest.sections ?? []) {
    assert.ok(existsSync(new URL(`../${section.module}`, import.meta.url)), section.module);
    assert.ok(pkg.files.some((entry) => section.module === entry || section.module.startsWith(`${entry}/`)), section.module);
    const root = element();
    const { dispose } = (await import(`../${section.module}`)).mount(root, { card: "c1", surface: "t1" });
    assert.deepEqual(root.children[0].children.map((item) => item.textContent),
      [`${section.name}: 내용 준비 중`, "카드: c1", "탭: t1"], section.id);
    dispose();
    assert.equal(root.children.length, 0, section.id);
  }
  delete globalThis.document;
});
