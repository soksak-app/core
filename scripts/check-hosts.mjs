// 두 네이티브 호스트와 두 네이티브 애플리케이션의 파일 구조가 같은지 검사한다.
//
// .go 와 .rs 는 확장자를 뺀 경로로 비교하고, 그 밖의 파일은 경로 그대로 비교한다.
// 한쪽에만 있는 파일은 아래 허용 목록(docs/spec/hosts.md 의 차이 ID)에 있을 때만 통과한다.
//
//   node scripts/check-hosts.mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

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

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: ROOT, encoding: "utf8" }).split("\0").filter((path) => path && existsSync(`${ROOT}${path}`));

/** 디렉터리 아래 파일을 비교용 경로로 바꾼다. */
function tree(dir) {
  const prefix = `${dir}/`;
  return new Set(tracked
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).replace(/\.(go|rs)$/, "")));
}

const allowed = (path, table) => Object.keys(table).some((key) => key.endsWith("/") ? path.startsWith(key) : path === key);

const errors = [];
for (const pair of PAIRS) {
  const left = tree(pair.left);
  const right = tree(pair.right);
  if (left.size === 0) errors.push(`${pair.left}: no files`);
  if (right.size === 0) errors.push(`${pair.right}: no files`);
  for (const path of left) {
    if (!right.has(path) && !allowed(path, pair.only.left)) errors.push(`${pair.left}/${path}: no counterpart in ${pair.right}`);
  }
  for (const path of right) {
    if (!left.has(path) && !allowed(path, pair.only.right)) errors.push(`${pair.right}/${path}: no counterpart in ${pair.left}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Host structure checks passed: ${PAIRS.length} pairs`);
}
