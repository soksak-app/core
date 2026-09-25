// 공개 항목의 이름이 선언과 맞는지 검사한다.
//
// 규칙(AGENTS.md, docs/spec/exposure.md):
//   1. 소스에 적은 공개 이름(따옴표 안의 이름, data-expose, data-command, 연결과 실행)은
//      선언되어 있다.
//   2. 선언한 status 와 명령은 등록되고, 선언한 dom 이름은 요소에 붙는 값으로 적혀 있다.
// 조작 요소가 명령과 dom 이름을 갖는지는 실행 중인 문서의 audit(core.page.audit,
// core.surface.document 의 unbound)가 판단한다. 소스 모양으로 추측하지 않는다.
// 워크벤치(코어)와 플러그인 페이지(plugins/*/ui)를 같은 규칙으로 검사한다.
//
//   node scripts/check-exposure.mjs
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const WORKBENCH = join(ROOT, "packages/workbench");
const PLUGINS = join(ROOT, "plugins");

/* 공개 이름이 아닌 따옴표 안의 점 이름. 파일 이름이다. */
const FILE = /\.(html|js|mjs|json|css)$/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function* files(dir, test) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["node_modules", "test", "dist", "build"].includes(name)) yield* files(path, test);
    } else if (test(name)) {
      yield path;
    }
  }
}

const errors = [];
const report = (path, index, text) => errors.push(`${relative(ROOT, path)}:${index + 1}: ${text}`);

/** 한 구성 요소(코어 또는 플러그인 하나)를 검사한다. */
function check({ owner, exposes, sources, registrations, sections = new Set(), core = null }) {
  const declared = {
    status: new Set((exposes.status ?? []).map((e) => e.name)),
    command: new Set((exposes.commands ?? []).map((e) => e.name)),
    dom: new Set((exposes.dom ?? []).map((e) => e.name)),
  };
  const any = (name) => declared.status.has(name) || declared.command.has(name) || declared.dom.has(name);
  const quoted = new RegExp(`["'\`](${owner}\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*)["'\`]`, "g");
  const shown = new Set();
  const texts = [];

  for (const path of sources) {
    const text = readFileSync(path, "utf8");
    texts.push(text);
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      // 1. 이름
      if (sections.has(path)) {
        for (const [, name] of line.matchAll(/["'`](core\.[a-z0-9-]+(?:\.[a-z0-9-]+)*)["'`]/g)) {
          if (!core.status.has(name) && !core.command.has(name)) report(path, index, `${name} is not a declared core status or command`);
        }
      }
      for (const [, name] of line.matchAll(quoted)) {
        if (!FILE.test(name) && !any(name)) report(path, index, `${name} is not declared`);
      }
      for (const [, name] of line.matchAll(/data-command=["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `data-command ${name} is not a declared command`);
      }
      for (const [, name] of line.matchAll(/\b(?:mark|bind)\(\s*\w+(?:\.\w+|\([^)]*\))*\s*,\s*["']([^"']+)["']/g)) {
        // 섹션 모듈은 코어 명령도 연결할 수 있다(docs/spec/plugins.md#sections).
        const coreCommand = sections.has(path) && core?.command.has(name);
        if (!declared.command.has(name) && !coreCommand) report(path, index, `${name} is bound to an element but is not a declared command`);
      }
      for (const [, name] of line.matchAll(/\b(?:run|command)\(\s*["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `${name} is run but is not a declared command`);
      }
      const domNames = [
        ...[...line.matchAll(/data-expose=["']([^"']+)["']/g)].map((m) => m[1]),
        ...[...line.matchAll(/[Ee]xpose\s*[:=]\s*["']([^"']+)["']/g)].map((m) => m[1]),
        ...(line.includes("dataset.expose") ? [...line.matchAll(quoted)].map((m) => m[1]) : []),
        ...[...line.matchAll(/(?:expose|context\.exposure)\.dom\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
      ];
      // 이름을 인자로 받아 요소에 붙이는 함수(act, field 등)도 있으므로, 선언된 dom
      // 이름이 따옴표로 적힌 곳은 표시한 곳으로 센다.
      for (const [, name] of line.matchAll(quoted)) if (declared.dom.has(name)) shown.add(name);
      for (const name of domNames) {
        if (name.includes("${")) continue;
        shown.add(name);
        if (!declared.dom.has(name)) report(path, index, `data-expose ${name} is not a declared dom entry`);
      }
    });
  }

  // 2. 등록과 표시
  const all = texts.join("\n") + registrations.map((path) => readFileSync(path, "utf8")).join("\n");
  const where = owner === "core" ? "packages/workbench" : `plugins (${owner})`;
  for (const name of declared.status) {
    const pattern = owner === "core" ? `status\\(\\s*"${name}"` : `(?:expose|context\\.exposure)\\.status\\(\\s*["']${name}["']`;
    if (!new RegExp(pattern).test(all)) errors.push(`${where}: status ${name} is declared but not registered`);
  }
  for (const name of declared.command) {
    const pattern = owner === "core" ? `(?:registry|expose)\\.command\\(\\s*"${name}"` : `(?:expose|context\\.exposure)\\.command\\(\\s*["']${name}["']`;
    if (!new RegExp(pattern).test(all)) errors.push(`${where}: command ${name} is declared but not registered`);
  }
  for (const name of declared.dom) {
    if (!shown.has(name)) errors.push(`${where}: dom ${name} is declared but no element carries it`);
  }
}

const workbenchSources = [...files(WORKBENCH, (name) => /\.(js|html)$/.test(name) && !name.endsWith(".mjs"))];
const coreExposes = readJson(join(WORKBENCH, "exposure.json")).exposes;
const coreDeclared = {
  status: new Set((coreExposes.status ?? []).map((e) => e.name)),
  command: new Set((coreExposes.commands ?? []).map((e) => e.name)),
};
check({
  owner: "core",
  exposes: coreExposes,
  sources: workbenchSources,
  // 코어 표면 항목(core.surface.*)은 플러그인 페이지 인터페이스가 등록한다.
  registrations: [join(ROOT, "packages/plugin-api/page.js")],
});

let plugins = 0;
for (const name of readdirSync(PLUGINS)) {
  const manifestPath = join(PLUGINS, name, "plugin.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = readJson(manifestPath);
  const ui = join(PLUGINS, name, "ui");
  const sources = existsSync(ui) ? [...files(ui, (file) => /\.(js|html)$/.test(file))] : [];
  plugins++;
  // 진단 빌드에만 있는 선언(diagnostics.json)도 같은 규칙으로 검사한다.
  const diagnosticsPath = join(PLUGINS, name, "diagnostics.json");
  const diagnostics = existsSync(diagnosticsPath) ? readJson(diagnosticsPath).exposes : {};
  const exposes = Object.fromEntries(["status", "commands", "dom"].map((key) =>
    [key, [...(manifest.exposes?.[key] ?? []), ...(diagnostics[key] ?? [])]]));
  const sections = new Set((manifest.sections ?? []).map((section) => join(PLUGINS, name, section.module)));
  check({ owner: manifest.id, exposes, sources, registrations: [], sections, core: coreDeclared });
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Exposure checks passed: core and ${plugins} plugins`);
}
