// release 산출물에 진단 코드가 없는지 검사한다.
//
// 진단 코드(호스트의 진단 메서드, 창 녹화, 페이지 진단 모듈)는 진단 빌드에만 들어간다. 이
// 검사는 release 빌드 직후, 스테이징된 프런트엔드와 두 release 실행 파일을 읽는다.
// `make release-check` 가 release 빌드를 먼저 실행한다.
//
//   node scripts/check-release.mjs
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

const APPS = ["wailsv3", "tauriv2"];

/** 진단 코드의 표지. 진단 메서드 이름, 녹화 라이브러리 기호, 사이드카 진단 심볼이다. */
const MARKS = [
  { what: "diagnostic method", pattern: /diagnostics\.(fixture|drag|knob|transcript|capture|modal)/ },
  { what: "window capture symbol", pattern: /sp_capture_/ },
  { what: "sidecar diagnostic symbol", pattern: /sp_diag_/ },
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|mjs|html|json)$/.test(name)) yield path;
  }
}

// 스테이징된 사이드카 JSON에서 실행 파일 basename들을 추출한다.
// helpers 필드가 있으면 그것도 포함한다.
function* extractExecutableBasenames(sidecarJsonPath) {
  try {
    const content = JSON.parse(readFileSync(sidecarJsonPath, "utf8"));
    if (typeof content.executable === "string") {
      yield basename(content.executable);
    }
    if (Array.isArray(content.helpers)) {
      for (const helper of content.helpers) {
        if (typeof helper.executable === "string") {
          yield basename(helper.executable);
        }
      }
    }
  } catch {
    // 잘못된 JSON 이나 구조는 무시한다. validateSidecar 가 따로 검사한다.
  }
}

// 텍스트에서 진단 표지를 찾는다. 발견하면 errors 배열에 추가한다.
export const find = (errors, label, text) => {
  for (const mark of MARKS) {
    if (mark.pattern.test(text)) errors.push(`${label}: contains a ${mark.what} (${mark.pattern.exec(text)[0]})`);
  }
};

// CLI 로 직접 실행될 때만 검사를 수행한다.
if (import.meta.main) {
  const errors = [];

  for (const app of APPS) {
    const frontend = join(ROOT, "apps", app, "src", "frontend");
    const module = join(frontend, "diagnostics.js");
    if (!existsSync(module)) {
      errors.push(`${relative(ROOT, frontend)}: no staged diagnostics module; run the release build first`);
    } else {
      for (const path of files(frontend)) find(errors, relative(ROOT, path), readFileSync(path, "utf8"));
    }
    const executable = join(ROOT, "target", "release", `soksak-${app}`);
    if (!existsSync(executable)) {
      errors.push(`${relative(ROOT, executable)}: missing; run the release build first`);
      continue;
    }
    // 실행 파일은 바이트로 읽는다. 표지는 ASCII 이므로 latin1 로 해석해도 위치가 바뀌지 않는다.
    find(errors, relative(ROOT, executable), readFileSync(executable).toString("latin1"));

    // 스테이징된 사이드카 JSON 에서 실행 파일 basename 을 추출해 검사한다.
    const modulesDir = join(frontend, "modules");
    if (existsSync(modulesDir)) {
      for (const sidecarPath of files(modulesDir)) {
        if (!sidecarPath.endsWith("sidecar.json")) continue;
        for (const execName of extractExecutableBasenames(sidecarPath)) {
          const sidecarExe = join(ROOT, "target", "release", execName);
          if (!existsSync(sidecarExe)) {
            errors.push(`${relative(ROOT, sidecarExe)}: missing; run the release build first`);
            continue;
          }
          // 사이드카 실행 파일도 진단 코드를 검사한다.
          find(errors, relative(ROOT, sidecarExe), readFileSync(sidecarExe).toString("latin1"));
        }
      }
    }
  }

  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Release checks passed: ${APPS.length} applications`);
  }
}
