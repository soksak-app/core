// 코어 패키지가 플러그인과 사이드카의 이름을 코드에 적지 않았는지 검사한다.
//
// 구성 요소는 설정 파일로만 연결된다. 플러그인과 사이드카는 자기 repository 에 있고
// (docs/spec/plugins.md#repositories), 그 이름은 scripts/workspace-registry.json 이 선언한 폴더의
// package.json 과 plugin.json 에서 읽는다. 코어 패키지끼리의 참조는 이 검사의 대상이 아니다. 각 플러그인과
// 사이드카 repository 의 소스는 그 repository 가 검사한다. 애플리케이션(apps/)과 창 검사(e2e/)는 조합을
// 소유하므로 검사하지 않는다. 선언 파일(package.json, plugin.json, sidecar.json)과 문서(.md)도 검사하지 않는다.
//
//   node scripts/check-boundaries.mjs [core checkout]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkDeclaration } from "./workspace-registry.mjs";

const ROOT = resolve(process.argv[2] ?? new URL("../", import.meta.url).pathname);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "frontend", "bin", "gen"]);
const SKIP_FILES = new Set(["package.json", "plugin.json", "sidecar.json"]);
const SOURCE = /\.(js|mjs|html|css|json|go|rs|m|h|toml)$/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const listDirs = (path) => existsSync(path)
  ? readdirSync(path).map((name) => join(path, name)).filter((dir) => existsSync(join(dir, "package.json")))
  : [];

/** 구성 요소. kind 는 core, plugin, sidecar 중 하나다. 소스를 읽는 것은 이 checkout 의 core 뿐이다. */
function components() {
  const found = [];
  const add = (dir, kind) => {
    const pkg = readJson(join(dir, "package.json"));
    const allowed = new Set([pkg.name, ...Object.keys({
      ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies,
    })]);
    const manifest = existsSync(join(dir, "plugin.json")) ? readJson(join(dir, "plugin.json")) : null;
    found.push({ dir, kind, name: pkg.name, allowed, pluginId: manifest?.id ?? null });
  };
  for (const dir of listDirs(join(ROOT, "packages"))) add(dir, "core");
  for (const dir of listDirs(join(ROOT, "packages/host"))) add(dir, "core");
  const declaration = checkDeclaration(readJson(join(ROOT, "scripts/workspace-registry.json")));
  for (const folder of declaration.plugins) add(resolve(ROOT, folder), "plugin");
  for (const { repository, folder } of declaration.sidecars) add(resolve(ROOT, repository, folder), "sidecar");
  return found;
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* files(path);
    } else if (SOURCE.test(name) && !SKIP_FILES.has(name)) {
      yield path;
    }
  }
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const all = components();
const errors = [];
for (const component of all.filter((item) => item.kind === "core")) {
  // 플러그인과 사이드카의 패키지 이름과, 플러그인 id 를 따옴표·속성값·섹션 접두사로 쓴 곳을 찾는다.
  const rules = [];
  for (const other of all) {
    if (other === component || component.allowed.has(other.name) || other.kind === "core") continue;
    rules.push({ what: `package ${other.name}`, pattern: new RegExp(`(^|[^\\w@/-])${escape(other.name)}($|[^\\w/-])`) });
    if (other.pluginId) {
      const id = escape(other.pluginId);
      rules.push({
        what: `plugin id ${other.pluginId}`,
        pattern: new RegExp(`["'\`=]${id}(["'\`\\]:]|\\.[a-z])`),
      });
    }
  }
  for (const path of files(component.dir)) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const rule of rules) {
        if (rule.pattern.test(line)) {
          errors.push(`${relative(ROOT, path)}:${index + 1}: ${component.kind} ${component.name} names ${rule.what}`);
        }
      }
    });
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Boundary checks passed: ${all.length} components`);
}
