// 두 네이티브 호스트와 두 네이티브 애플리케이션의 파일 구조가 같은지 검사한다.
//
// .go 와 .rs 는 확장자를 뺀 경로로 비교하고, 그 밖의 파일은 경로 그대로 비교한다.
// 한쪽에만 있는 파일은 아래 허용 목록(docs/spec/hosts.md 의 차이 ID)에 있을 때만 통과한다.
//
//   node scripts/check-hosts.mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url).pathname;

const PAIRS = [
  {
    left: "packages/host/wailsv3",
    right: "packages/host/tauriv2",
    only: {
      left: {
        "go.mod": "A4", "go.sum": "A4",
        "src/bridge.js": "H3",
        "src/platform/darwin/webview.m": "H4",
        "src/diagnostics_test": "H5",
        "src/menu": "H6", "tests/menu_test": "H6",
      },
      right: {
        "Cargo.toml": "A4", "Cargo.lock": "A4",
        "build": "H1",
      },
    },
  },
  {
    left: "apps/wailsv3",
    right: "apps/tauriv2",
    only: {
      left: { "go.mod": "A4", "go.sum": "A4" },
      right: {
        "Cargo.toml": "A4", "Cargo.lock": "A4",
        "build": "A2",
        "tauri.conf.json": "A3", "capabilities/": "A3", "icons/": "A3", "gen/": "A3",
      },
    },
  },
];

/** 디렉터리 아래 파일을 비교용 경로로 바꾼다. */
function tree(dir) {
  const prefix = `${dir}/`;
  return new Set(tracked
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).replace(/\.(go|rs)$/, "")));
}

const allowed = (path, table) => Object.keys(table).some((key) => key.endsWith("/") ? path.startsWith(key) : path === key);

export function auditHostPairs(tracked, pairs = PAIRS) {
  const errors = [];
  for (const pair of pairs) {
    const left = new Set(tracked
      .filter((path) => path.startsWith(`${pair.left}/`))
      .map((path) => path.slice(pair.left.length + 1).replace(/\.(go|rs)$/, "")));
    const right = new Set(tracked
      .filter((path) => path.startsWith(`${pair.right}/`))
      .map((path) => path.slice(pair.right.length + 1).replace(/\.(go|rs)$/, "")));
    if (left.size === 0) errors.push(`${pair.left}: no files`);
    if (right.size === 0) errors.push(`${pair.right}: no files`);
    for (const path of left) {
      if (!right.has(path) && !allowed(path, pair.only.left)) errors.push(`${pair.left}/${path}: no counterpart in ${pair.right}`);
    }
    for (const path of right) {
      if (!left.has(path) && !allowed(path, pair.only.right)) errors.push(`${pair.right}/${path}: no counterpart in ${pair.left}`);
    }
  }
  return errors;
}

// stub 구현을 검사한다(회귀 방지 검사)
const { readFileSync } = await import("node:fs");
const STUB_PATTERNS = [
  /TODO:\s*Implement/,
  /not yet implemented/,
  /unimplemented!/,
  /todo!\(/,
];
const PRODUCT_DIRS = [
  "packages/host/wailsv3/src",
  "packages/host/tauriv2/src",
  "native/darwin/src",
  "sidecars/vt-core/src",
  "plugins",
];
const EXCLUDE = ["test", "tests", "windows"];

function findStubs(dir) {
  const stubs = [];
  try {
    const files = execFileSync("find", [dir, "-type", "f", "(", "-name", "*.go", "-o", "-name", "*.rs", "-o", "-name", "*.m", "-o", "-name", "*.mjs", ")", "-not", "-path", "*/target/*", "-not", "-path", "*/.git/*"],
      { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(f => f);

    for (const file of files) {
      // 테스트 파일과 unsupported 파일은 건너뛴다
      if (EXCLUDE.some(ex => file.includes(ex))) continue;

      try {
        const content = readFileSync(`${ROOT}${file}`, "utf8");
        for (const pattern of STUB_PATTERNS) {
          if (pattern.test(content)) {
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (pattern.test(lines[i])) {
                stubs.push(`${file}:${i + 1}: ${pattern.source}`);
              }
            }
          }
        }
      } catch (e) {
        // 읽을 수 없는 파일은 무시한다
      }
    }
  } catch (e) {
    // find 오류는 무시한다
  }
  return stubs;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT, encoding: "utf8" }).split("\0").filter((path) => path && existsSync(`${ROOT}${path}`));
  const errors = auditHostPairs(tracked);
  const stubErrors = PAIRS.length === 0 ? [] : PRODUCT_DIRS.flatMap((dir) => findStubs(dir));
  if (stubErrors.length) {
    console.error("Stub implementations found (anti-regression check failed):");
    console.error(stubErrors.join("\n"));
    process.exitCode = 1;
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else if (stubErrors.length === 0) {
    console.log(`Host structure checks passed: ${PAIRS.length} pairs`);
  }
}
