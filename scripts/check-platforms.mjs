// 운영체제별 코드가 platform/<os>/ 아래에만 있는지 검사한다.
//
// 다른 운영체제를 추가할 때 디렉터리 하나를 추가하면 되도록, 운영체제 조건과 운영체제
// 접미사 파일은 소유 패키지의 platform/<os>/ 에만 둔다. 다음은 검사하지 않는다.
//
//   native/<os>/                      디렉터리 이름이 운영체제를 나타낸다
//   scripts/check-build-environment.sh 빌드 도구가 실행 중인 호스트를 확인한다
//   Cargo.toml                        대상별 의존성 표는 선언이다
//   platform/platform.{go,rs,js}      구현 선택 파일
//   scripts/check-platforms.mjs       이 검사 자신
//
//   node scripts/check-platforms.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const OS = "(darwin|macos|linux|windows|unix|other|freebsd|ios|android)";
const SOURCE = /\.(js|mjs|go|rs|m|h|sh)$/;
const SKIPPED = [
  /^native\/[^/]+\//,
  /^scripts\/check-build-environment\.sh$/,
  // 이 파일은 command supervisor가 현재 호스트를 지원하는지 확인한다.
  // 이는 실행 환경 계약이며 OS 구현이 아니다.
  /^scripts\/test-command\.mjs$/,
  /(^|\/)platform\/platform\.(go|rs|js)$/,
  /^scripts\/check-platforms\.mjs$/,
];
const RULES = [
  { what: "Go runtime.GOOS", pattern: /\bruntime\.GOOS\b/ },
  { what: "Go OS build tag", pattern: new RegExp(`^//go:build .*\\b!?${OS}\\b`) },
  { what: "Rust OS cfg", pattern: /cfg!?\((not\()?(target_os|unix|windows)\b/ },
  { what: "Node process.platform", pattern: /\bprocess\.platform\b/ },
];

// platform adapter는 domain 디렉터리 아래에 묶일 수도 있다(예:
// platform/pty.rs). 소유 platform root는 여전히 명시적이다.
const inPlatform = (path) => /(^|\/)platform\//.test(path);
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: ROOT, encoding: "utf8" }).split("\0").filter((path) => path && existsSync(`${ROOT}${path}`));
const errors = [];
for (const path of files) {
  if (SKIPPED.some((skip) => skip.test(path)) || inPlatform(path)) continue;
  if (new RegExp(`_${OS}\\.(go|rs|m|h)$`).test(path)) errors.push(`${path}: operating system file suffix`);
  if (!SOURCE.test(path)) continue;
  readFileSync(`${ROOT}${path}`, "utf8").split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) errors.push(`${path}:${index + 1}: ${rule.what} outside platform/<os>/`);
    }
  });
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Platform checks passed: ${files.length} files`);
}
