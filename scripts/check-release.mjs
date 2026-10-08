// Checks the diagnostic code of the release bundles. While the version is 0.0.x every release is a diagnostic build
// (AGENTS.md), so its executables carry the diagnostic methods and the frontend embeds the page diagnostic module; a
// later version series carries no diagnostic code and embeds the release page diagnostic module.
//
// 진단 코드(호스트의 진단 메서드, 창 녹화, 페이지 진단 모듈)는 진단 빌드에만 들어간다. 이 검사는 지정한
// 번들의 Contents/MacOS 에 있는 모든 실행 파일을 읽는다. 두 애플리케이션은 프런트엔드를 압축 없이 실행 파일에
// 넣으므로, 워크벤치가 배포하는 모든 파일과 release 페이지 진단 모듈이 실행 파일에 원문 그대로 있어야
// 프런트엔드를 검사할 수 있다. 하나라도 없으면 프런트엔드를 읽을 수 없다는 오류를 낸다. 워크벤치는 애플리케이션
// package.json 의 의존성으로 찾는다. 플러그인과 사이드카는 번들에 없고 설정 폴더에 설치된다(docs/spec/installation.md).
// `make release-check` 가 release 빌드를 먼저 실행한다.
//
// The check also compares each bundle with the macOS minimum of the Makefile (`MACOS_MINIMUM`): Info.plist declares it
// in LSMinimumSystemVersion, the application executable is built for it, and no other executable is built for a newer
// macOS (docs/spec/hosts.md#nativedarwin).
//
//   node scripts/check-release.mjs --macos-minimum VERSION --wailsv3-bundle PATH --tauriv2-bundle PATH
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { plistString, RELEASE } from "./check-versions.mjs";

const ROOT = new URL("../", import.meta.url).pathname;

const APPS = ["wailsv3", "tauriv2"];

/** 진단 코드의 표지. 진단 메서드 이름, 녹화 라이브러리 기호, 사이드카 진단 심볼이다. */
const MARKS = [
  { what: "diagnostic method", pattern: /diagnostics\.(fixture|drag|knob|transcript|capture|modal|surface)/ },
  { what: "window capture symbol", pattern: /sp_capture_/ },
  // 기호를 벗긴 release 실행 파일에는 sp_capture_ 가 없다. 녹화의 ObjC 클래스 이름은 문자열로 남는다.
  { what: "window capture class", pattern: /SPCapture/ },
  { what: "sidecar diagnostic symbol", pattern: /sp_diag_/ },
  // release build 는 진단 인자 --registry-ca 를 선언하지 않는다(docs/spec/hosts.md#application-arguments).
  { what: "diagnostic argument", pattern: /registry-ca/ },
];

/** Whether a release of version is a diagnostic build: every 0.0.x release is one (AGENTS.md). */
export const diagnosticRelease = (version) => /^0\.0\./.test(version);

/**
 * Audits the diagnostic code of an executable. A diagnostic release requires the diagnostic methods; another release
 * refuses every diagnostic mark.
 */
export function auditDiagnostics(errors, label, text, required) {
  if (!required) return find(errors, label, text);
  if (!MARKS[0].pattern.test(text)) errors.push(`${label}: lacks the diagnostic methods that a 0.0.x release carries`);
}

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
 * 바이트다. 배포 파일이나 release 모듈이 원문으로 없으면 프런트엔드를 읽을 수 없다는 오류를 낸다.
 */
export function auditFrontend(errors, label, text, { published, pageModule, pageModuleName }) {
  const missing = published.filter((file) => !text.includes(latin1(file.bytes))).map((file) => file.path);
  if (!text.includes(latin1(pageModule))) missing.push(pageModuleName);
  if (missing.length) errors.push(`${label}: does not embed a readable frontend; missing ${missing.join(", ")}`);
}

/** The minimum macOS version of a thin 64-bit Mach-O executable, from LC_BUILD_VERSION or LC_VERSION_MIN_MACOSX. */
export function machoMinimum(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error("not a 64-bit Mach-O executable");
  const count = bytes.readUInt32LE(16);
  for (let offset = 32, index = 0; index < count && offset + 16 <= bytes.length; index += 1) {
    const cmd = bytes.readUInt32LE(offset);
    const at = cmd === 0x32 ? offset + 12 : cmd === 0x24 ? offset + 8 : -1;
    if (at >= 0) {
      const encoded = bytes.readUInt32LE(at);
      const patch = encoded & 0xff;
      return `${encoded >>> 16}.${(encoded >>> 8) & 0xff}${patch ? `.${patch}` : ""}`;
    }
    offset += bytes.readUInt32LE(offset + 4);
  }
  throw new Error("declares no minimum macOS version");
}

/** Negative, zero or positive as version a is older than, equal to or newer than version b. */
function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0); // default: a missing component is 0
    if (difference) return difference;
  }
  return 0;
}

/**
 * Compares a bundle with the macOS minimum. plist is the text of Contents/Info.plist; executables are
 * {path, application, minimum}. The application executable is built for the minimum, and no other executable is
 * built for a newer macOS.
 */
export function auditMinimum(errors, bundle, minimum, plist, executables) {
  const declared = plistString(plist, "LSMinimumSystemVersion");
  // default: an absent key is reported as missing.
  if (declared !== minimum) errors.push(`${join(bundle, "Contents/Info.plist")}: LSMinimumSystemVersion is ${declared ?? "missing"}, not the macOS minimum ${minimum}`);
  for (const executable of executables) {
    if (executable.application && compareVersions(executable.minimum, minimum) !== 0) {
      errors.push(`${executable.path}: built for macOS ${executable.minimum}, not the macOS minimum ${minimum}`);
    } else if (compareVersions(executable.minimum, minimum) > 0) {
      errors.push(`${executable.path}: built for macOS ${executable.minimum}, newer than the macOS minimum ${minimum}`);
    }
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

/**
 * The published files of the workbench of an application and the page diagnostic module that a release embeds: the
 * diagnostic module (observe.js) in a diagnostic release, the release module otherwise.
 */
function applicationSources(app, diagnostic) {
  const appDir = join(ROOT, "apps", app);
  const workbench = packageDir(appDir, "@soksak/workbench");
  const { files } = JSON.parse(readFileSync(join(workbench, "package.json"), "utf8"));
  const published = files.flatMap((file) => [...expand(workbench, file)]).map((path) => ({ path, bytes: readFileSync(join(workbench, path)) }));
  const module = diagnostic ? "observe.js" : "release-diagnostics.js";
  return { published, pageModule: readFileSync(join(workbench, module)), pageModuleName: `page diagnostics module ${module}` };
}

// CLI 로 직접 실행될 때만 검사를 수행한다.
if (import.meta.main) {
  const bundles = new Map();
  let minimum;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (option === "--macos-minimum") {
      if (minimum !== undefined) throw new Error(`duplicate release option: ${option}`);
      minimum = args[index + 1];
      if (typeof minimum !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(minimum)) throw new Error(`${option} requires a macOS version such as 14.4`);
      continue;
    }
    const app = APPS.find((app) => option === `--${app}-bundle`);
    if (!app) throw new Error(`unknown release option: ${option}`);
    if (bundles.has(app)) throw new Error(`duplicate release option: ${option}`);
    const path = args[index + 1];
    if (!path || path.startsWith("--")) throw new Error(`${option} requires a bundle path`);
    bundles.set(app, resolve(path));
  }
  if (minimum === undefined || bundles.size !== APPS.length) {
    throw new Error("required release options: --macos-minimum VERSION --wailsv3-bundle PATH --tauriv2-bundle PATH");
  }
  const errors = [];
  // The version of the release is the declared workspace version.
  const version = RELEASE;
  const diagnostic = diagnosticRelease(version);

  for (const app of APPS) {
    // 애플리케이션과 command line sok 은 번들의 Contents/MacOS 에 있다(docs/spec/hosts.md).
    const executables = join(bundles.get(app), "Contents", "MacOS");
    const executable = join(executables, `soksak-${app}`);
    if (!existsSync(executable)) {
      errors.push(`${executable}: missing; run the release build first`);
      continue;
    }
    // 실행 파일은 바이트로 읽는다. 표지는 ASCII 이므로 latin1 로 해석해도 위치가 바뀌지 않는다.
    const built = [];
    for (const name of readdirSync(executables)) {
      const path = join(executables, name);
      const bytes = readFileSync(path);
      const text = latin1(bytes);
      // A diagnostic release requires the diagnostic methods in the application and in sok; the other executables
      // are sidecar helpers that carry none.
      if (path === executable || name === "sok") auditDiagnostics(errors, path, text, diagnostic);
      else find(errors, path, text);
      if (path === executable) auditFrontend(errors, path, text, applicationSources(app, diagnostic));
      try {
        built.push({ path, application: path === executable, minimum: machoMinimum(bytes) });
      } catch (error) {
        errors.push(`${path}: ${error.message}`);
      }
    }
    const plist = join(bundles.get(app), "Contents", "Info.plist");
    auditMinimum(errors, bundles.get(app), minimum, existsSync(plist) ? readFileSync(plist, "utf8") : "", built);
  }

  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Release checks passed: ${APPS.length} applications, ${diagnostic ? "diagnostic" : "without diagnostics"} for version ${version}`);
  }
}
