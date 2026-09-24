// 코어, 플러그인, 사이드카가 서로의 이름을 코드에 적지 않았는지 검사한다.
//
// 구성 요소는 설정 파일로만 연결된다. 코어 패키지는 플러그인과 사이드카의 이름을 적지 않는다.
// 플러그인과 사이드카는 package.json 에 의존성으로 선언한 패키지 이름만 적을 수 있다. 코어
// 패키지끼리의 참조는 이 검사의 대상이 아니다. 사이드카에는 플러그인 개념이 없으므로 플러그인에 의존하는 길은
// 패키지 이름뿐이다. 사이드카의 셸, 터미널 같은 영역 용어가 플러그인 id 와 같아도 참조가 아니므로, 플러그인 id
// 규칙은 코어와 플러그인에만 적용한다. 애플리케이션(apps/)과 창 검사(e2e/)는
// 조합을 소유하므로 검사하지 않는다. 선언 파일(package.json, plugin.json, sidecar.json)과
// 문서(.md)도 검사하지 않는다.
//
//   node scripts/check-boundaries.mjs
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "frontend", "bin", "gen"]);
const SKIP_FILES = new Set(["package.json", "plugin.json", "sidecar.json"]);
const SOURCE = /\.(js|mjs|html|css|json|go|rs|m|h|toml)$/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const listDirs = (path) => existsSync(path)
  ? readdirSync(path).map((name) => join(path, name)).filter((dir) => existsSync(join(dir, "package.json")))
  : [];

/** 검사 대상 구성 요소. kind 는 core, plugin, sidecar 중 하나다. */
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
  for (const dir of listDirs(join(ROOT, "plugins"))) add(dir, "plugin");
  for (const dir of listDirs(join(ROOT, "sidecars"))) add(dir, "sidecar");
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
for (const component of all) {
  // 다른 구성 요소의 패키지 이름과, 플러그인 id 를 따옴표·속성값·섹션 접두사로 쓴 곳을 찾는다.
  const rules = [];
  for (const other of all) {
    if (other === component || component.allowed.has(other.name) || other.kind === "core") continue;
    rules.push({ what: `package ${other.name}`, pattern: new RegExp(`(^|[^\\w@/-])${escape(other.name)}($|[^\\w/-])`) });
    if (other.pluginId && component.kind !== "sidecar") {
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
