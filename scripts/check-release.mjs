// release 번들에 진단 코드가 없는지 검사한다.
//
// 진단 코드(호스트의 진단 메서드, 창 녹화, 페이지 진단 모듈, 플러그인의 diagnostics.json 선언과
// 모듈)는 진단 빌드에만 들어간다. 이 검사는 지정한 번들의 Contents/MacOS 에 있는 모든 실행 파일을
// 읽는다. 두 애플리케이션은 프런트엔드를 압축 없이 실행 파일에 넣으므로, 워크벤치가 배포하는 모든
// 파일과 release 페이지 진단 모듈이 실행 파일에 원문 그대로 있어야 프런트엔드를 검사할 수 있다.
// 하나라도 없으면 프런트엔드를 읽을 수 없다는 오류를 낸다. 워크벤치와 플러그인은 애플리케이션
// package.json 의 의존성으로 찾는다.
// `make release-check` 가 release 빌드를 먼저 실행한다.
//
//   node scripts/check-release.mjs --wailsv3-bundle PATH --tauriv2-bundle PATH
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

const APPS = ["wailsv3", "tauriv2"];

/** 진단 코드의 표지. 진단 메서드 이름, 녹화 라이브러리 기호, 사이드카 진단 심볼이다. */
const MARKS = [
  { what: "diagnostic method", pattern: /diagnostics\.(fixture|drag|knob|transcript|capture|modal)/ },
  { what: "window capture symbol", pattern: /sp_capture_/ },
  // 기호를 벗긴 release 실행 파일에는 sp_capture_ 가 없다. 녹화의 ObjC 클래스 이름은 문자열로 남는다.
  { what: "window capture class", pattern: /SPCapture/ },
  { what: "sidecar diagnostic symbol", pattern: /sp_diag_/ },
];

// 텍스트에서 진단 표지를 찾는다. 발견하면 errors 배열에 추가한다.
export const find = (errors, label, text) => {
  for (const mark of MARKS) {
    if (mark.pattern.test(text)) errors.push(`${label}: contains a ${mark.what} (${mark.pattern.exec(text)[0]})`);
  }
};

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

/**
 * 애플리케이션 실행 파일에 포함된 프런트엔드를 검사한다. text 는 실행 파일을 latin1 로 읽은 내용이다.
 * published 는 워크벤치가 배포하는 파일 {path, bytes}, releaseModule 은 release 페이지 진단 모듈의
 * 바이트, plugins 는 {package, entries, module} 이다. entries 는 진단 항목 이름, module 은 진단 모듈
 * 원본 바이트다. 배포 파일이나 release 모듈이 원문으로 없으면 프런트엔드를 읽을 수 없으므로 그 오류만 낸다.
 */
export function auditFrontend(errors, label, text, { published, releaseModule, plugins }) {
  const missing = published.filter((file) => !text.includes(latin1(file.bytes))).map((file) => file.path);
  if (!text.includes(latin1(releaseModule))) missing.push("release page diagnostics module");
  if (missing.length) {
    errors.push(`${label}: does not embed a readable frontend; missing ${missing.join(", ")}`);
    return;
  }
  for (const plugin of plugins) {
    for (const entry of plugin.entries) {
      if (text.includes(`"${entry}"`)) errors.push(`${label}: contains the diagnostic entry ${entry}`);
    }
    if (text.includes(latin1(plugin.module))) errors.push(`${label}: contains the diagnostic module of ${plugin.package}`);
  }
}

/** from 패키지의 의존성으로 name 패키지의 디렉터리를 찾는다. */
function packageDir(from, name) {
  return dirname(createRequire(join(from, "package.json")).resolve(`${name}/package.json`));
}

/** 디렉터리 항목은 그 아래 파일로 펼친다. */
function* expand(dir, path) {
  const full = join(dir, path);
  if (!statSync(full).isDirectory()) yield path;
  else for (const name of readdirSync(full)) yield* expand(dir, join(path, name));
}

/** 애플리케이션의 워크벤치 배포 파일, release 페이지 진단 모듈, 진단 선언을 가진 플러그인. */
function applicationSources(app) {
  const appDir = join(ROOT, "apps", app);
  const workbench = packageDir(appDir, "@soksak/workbench");
  const { files } = JSON.parse(readFileSync(join(workbench, "package.json"), "utf8"));
  const published = files.flatMap((file) => [...expand(workbench, file)]).map((path) => ({ path, bytes: readFileSync(join(workbench, path)) }));
  const environment = JSON.parse(readFileSync(join(appDir, "environment.json"), "utf8"));
  const plugins = environment.plugins.flatMap((name) => {
    const dir = packageDir(appDir, name);
    const path = join(dir, "diagnostics.json");
    if (!existsSync(path)) return [];
    const diagnostics = JSON.parse(readFileSync(path, "utf8"));
    return [{
      package: name,
      entries: Object.values(diagnostics.exposes).flat().map((entry) => entry.name),
      module: readFileSync(join(dir, diagnostics.module)),
    }];
  });
  return { published, releaseModule: readFileSync(join(workbench, "release-diagnostics.js")), plugins };
}

// CLI 로 직접 실행될 때만 검사를 수행한다.
if (import.meta.main) {
  const bundles = new Map();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const app = APPS.find((app) => option === `--${app}-bundle`);
    if (!app) throw new Error(`unknown release option: ${option}`);
    if (bundles.has(app)) throw new Error(`duplicate release option: ${option}`);
    const path = args[index + 1];
    if (!path || path.startsWith("--")) throw new Error(`${option} requires a bundle path`);
    bundles.set(app, resolve(path));
  }
  if (bundles.size !== APPS.length) throw new Error("required release bundle options: --wailsv3-bundle PATH --tauriv2-bundle PATH");
  const errors = [];

  for (const app of APPS) {
    // 애플리케이션과 사이드카는 번들의 Contents/MacOS 에 있다(docs/spec/hosts.md).
    const executables = join(bundles.get(app), "Contents", "MacOS");
    const executable = join(executables, `soksak-${app}`);
    if (!existsSync(executable)) {
      errors.push(`${executable}: missing; run the release build first`);
      continue;
    }
    // 실행 파일은 바이트로 읽는다. 표지는 ASCII 이므로 latin1 로 해석해도 위치가 바뀌지 않는다.
    for (const name of readdirSync(executables)) {
      const path = join(executables, name);
      const text = latin1(readFileSync(path));
      find(errors, path, text);
      if (path === executable) auditFrontend(errors, path, text, applicationSources(app));
    }
  }

  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Release checks passed: ${APPS.length} applications`);
  }
}
