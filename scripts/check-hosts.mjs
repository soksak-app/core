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
        "tests/panic_hook_test": "H7",
      },
    },
  },
  {
    left: "packages/sok/wailsv3",
    right: "packages/sok/tauriv2",
    only: {
      left: { "go.mod": "A4", "src/cmd/": "C1", "src/diagnostics_test": "C2", "src/dev_test": "C2", "tests/build_test": "C2", "src/dev": "C3" },
      right: { "Cargo.toml": "A4", "src/main": "C1" },
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
];
/** 검사하지 않는 경로. 테스트와 Windows unsupported 구현은 stub 문구를 정당하게 담는다. */
const EXCLUDE = /(^|\/)(test|tests|windows)(\/|$)/;
const STUB_SOURCE = /\.(go|rs|m|js|mjs)$/;

/**
 * 제품 소스의 stub 구현 줄을 돌려준다. files 는 저장소 상대 경로, read(file) 은 그 원문이다. 읽지 못한 파일은
 * 검사하지 못한 것이므로 경로를 담은 오류로 실패한다.
 */
export function findStubs(files, read) {
  const stubs = [];
  for (const file of files) {
    if (!PRODUCT_DIRS.some((dir) => file.startsWith(`${dir}/`)) || !STUB_SOURCE.test(file) || EXCLUDE.test(file)) continue;
    let content;
    try {
      content = read(file);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`, { cause: error });
    }
    content.split("\n").forEach((line, index) => {
      for (const pattern of STUB_PATTERNS) if (pattern.test(line)) stubs.push(`${file}:${index + 1}: ${pattern.source}`);
    });
  }
  return stubs;
}

// Tauri 명령의 인자는 framework 객체가 아니면 Argument<T> 다. 그래야 host 의 인자 decoder 가 해석하고 Wails host 와
// 같은 문장으로 거부한다(docs/spec/native-host.md#host-calls).
const FRAMEWORK_ARGUMENT = /^(Window|Webview|AppHandle|(tauri::)?State<.*>)$/s;
const COMMAND = /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\(([^)]*)\)/g;

/** source 의 Tauri 명령 중 framework 객체도 Argument<T> 도 아닌 인자를 돌려준다. */
export function findUndecodedCommandArguments(source, file) {
  const errors = [];
  for (const [, name, params] of source.matchAll(COMMAND)) {
    let depth = 0;
    let current = "";
    const parts = [];
    for (const ch of params) {
      if (ch === "<") depth++;
      if (ch === ">") depth--;
      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    parts.push(current);
    for (const part of parts.map((value) => value.trim()).filter(Boolean)) {
      const [argument, ...type] = part.split(":");
      const declared = type.join(":").trim();
      if (!FRAMEWORK_ARGUMENT.test(declared) && !declared.startsWith("Argument<")) {
        errors.push(`${file}: command ${name} argument ${argument.trim()} is ${declared}, not Argument<T>`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT, encoding: "utf8" }).split("\0").filter((path) => path && existsSync(`${ROOT}${path}`));
  const errors = auditHostPairs(tracked);
  for (const file of tracked.filter((path) => path.startsWith("packages/host/tauriv2/src/") && path.endsWith(".rs"))) {
    errors.push(...findUndecodedCommandArguments(readFileSync(`${ROOT}${file}`, "utf8"), file));
  }
  const stubErrors = findStubs(tracked, (file) => readFileSync(`${ROOT}${file}`, "utf8"));
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
