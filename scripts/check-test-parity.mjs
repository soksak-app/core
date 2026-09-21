// 구현·테스트 파일 소유를 검사한다. 이 구조 검사는 동작 검증을 대신하지 않는다.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const languages = {
  "js-ts": new Set([".js", ".mjs", ".ts", ".tsx"]),
  rust: new Set([".rs"]),
  go: new Set([".go"]),
  "objective-c": new Set([".m"]),
  declaration: new Set([".json"]),
};

const lane = (capability, language, implementation, tests, options = {}) => ({
  capability,
  language,
  implementation,
  tests,
  testLanguage: options.testLanguage ?? language,
  testExtensions: options.testExtensions ?? null,
  sharedTests: options.sharedTests ?? false,
});

// 기존 구성요소 연결도 파일 목록으로 유지한다. 동작 증거로 해석하지 않는다.
const MATRIX = [
  lane("test inventory", "js-ts", ["scripts/check-test-parity.mjs"], ["scripts/test/test-parity.test.mjs"]),
  lane("command supervision", "js-ts", ["scripts/test-command.mjs"], ["scripts/test/test-command.test.mjs"]),
  lane("documentation and checklist checks", "js-ts", ["scripts/check-docs.mjs", "scripts/checklist.mjs"], ["scripts/test/checklist.test.mjs"]),
  lane("Rust package test commands", "declaration", ["sidecars/vt-core/package.json", "sidecars/vt-alacritty/package.json"], ["scripts/test/package-test-command.test.mjs"], { testLanguage: "js-ts" }),
  lane("soksak layout", "js-ts", ["packages/soksak/src/**/*.ts"], ["packages/soksak/test/**/*.mjs"]),
  lane("plugin API", "js-ts", ["packages/plugin-api/*.js"], ["packages/plugin-api/test/**/*.mjs"]),
  lane("workbench", "js-ts", ["packages/workbench/*.js", "packages/workbench/*.mjs"], ["packages/workbench/test/**/*.js", "packages/workbench/test/**/*.mjs"]),
  lane("client", "js-ts", [
    "packages/client/*.js",
    "packages/client/platform/**/*.js",
    "packages/client/testing/**/*.js",
    "packages/client/bench/**/*.mjs",
  ], ["packages/client/test/**/*.mjs"]),
  lane("CLI", "js-ts", ["packages/cli/**/*.js"], ["packages/cli/test/**/*.mjs"]),
  lane("MCP client", "js-ts", ["packages/mcp/**/*.js"], ["packages/mcp/test/**/*.mjs"]),
  lane("browser plugin", "js-ts", ["plugins/browser/ui/**/*.js"], ["plugins/browser/test/**/*.mjs"]),
  lane("shell plugin", "js-ts", ["plugins/shell/ui/**/*.js"], ["plugins/shell/test/**/*.mjs"]),
  lane("terminal plugin", "js-ts", ["plugins/terminal/ui/**/*.js"], ["plugins/terminal/test/**/*.mjs"]),
  lane("browser runtime", "js-ts", ["apps/browser/runtime/**/*.js"], ["apps/browser/test/**/*.mjs"]),
  lane("Tauri runtime", "js-ts", ["apps/tauriv2/runtime/**/*.js"], ["apps/tauriv2/test/**/*.mjs"]),
  lane("Wails runtime", "js-ts", ["apps/wailsv3/runtime/**/*.js"], ["apps/wailsv3/test/**/*.mjs"]),
  lane("files plugin declaration", "declaration", ["plugins/files/plugin.json"], ["plugins/files/test/manifest.test.mjs"], { testLanguage: "js-ts" }),

  lane("Tauri host", "rust", ["packages/host/tauriv2/src/**/*.rs"], ["packages/host/tauriv2/tests/**/*.rs"]),
  lane("Tauri application bootstrap", "rust", ["apps/tauriv2/src/main.rs"], ["e2e/hosts.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("VT core", "rust", ["sidecars/vt-core/src/**/*.rs"], ["sidecars/vt-core/tests/**/*.rs"]),
  lane("VT Alacritty sidecar", "rust", ["sidecars/vt-alacritty/src/**/*.rs"], ["sidecars/vt-alacritty/tests/**/*.rs"]),

  lane("Wails host", "go", ["packages/host/wailsv3/src/**/*.go"], ["packages/host/wailsv3/tests/**/*.go"]),
  lane("Wails application bootstrap", "go", ["apps/wailsv3/src/main.go"], ["e2e/hosts.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("shell sidecar", "go", ["sidecars/shell/src/**/*.go"], ["sidecars/shell/tests/**/*.go", "sidecars/shell/tests/**/*.mjs"], {
    testLanguage: "mixed",
    testExtensions: new Set([".go", ".mjs"]),
  }),

  lane("Darwin clipboard", "objective-c", ["native/darwin/src/clipboard.m"], ["native/darwin/tests/clipboard_test.m"]),
  lane("Darwin document and surface", "objective-c", [
    "native/darwin/src/document_view.m",
    "native/darwin/src/image_region.m",
    "native/darwin/src/surface_layout.m",
    "native/darwin/src/webview_geometry.m",
  ], [
    "native/darwin/tests/document_view_test.m",
    "native/darwin/tests/image_region_test.m",
    "native/darwin/tests/surface_layout_test.m",
    "native/darwin/tests/webview_geometry_test.m",
    "native/darwin/tests/webview_inspector_test.m",
    "native/darwin/tests/surface_host_test.m",
  ]),
  lane("Darwin input", "objective-c", [
    "native/darwin/src/input_inject.m",
    "native/darwin/src/webview_input.m",
  ], [
    "native/darwin/tests/input_activate_test.m",
    "native/darwin/tests/input_inject_test.m",
    "native/darwin/tests/webview_focus_test.m",
    "native/darwin/tests/webview_input_test.m",
  ]),
  lane("Darwin window", "objective-c", ["native/darwin/src/window_*.m"], ["native/darwin/tests/window_*_test.m"]),
  lane("Darwin UI queue", "objective-c", ["native/darwin/src/ui_queue.m"], ["native/darwin/tests/ui_queue_test.m"]),
  lane("Darwin capture", "objective-c", ["native/darwin/src/capture.m"], ["native/darwin/tests/capture_test.m"]),
  lane("Darwin dock menu", "objective-c", ["native/darwin/src/dock_menu.m"], ["native/darwin/tests/dock_menu_test.m"]),
];

// 생성 산출물은 원본과의 일치 검사 대상이며 독립 구현으로 세지 않는다.
const GENERATED_ROOTS = new Map([
  ["packages/soksak/dist/", "generated library output; verified by make verify"],
  ["apps/tauriv2/gen/schemas/", "generated Tauri permission schemas"],
]);

const sourceLanguages = new Map([
  [".js", "js-ts"], [".mjs", "js-ts"], [".cjs", "js-ts"], [".ts", "js-ts"], [".tsx", "js-ts"],
  [".rs", "rust"], [".go", "go"], [".m", "objective-c"], [".mm", "objective-c"],
  [".h", "native-interface"], [".c", "c"], [".cc", "cpp"], [".cpp", "cpp"],
  [".html", "document"], [".css", "stylesheet"], [".sh", "shell"],
]);
const manifestNames = new Set(["package.json", "Cargo.toml", "go.mod", "Makefile"]);
const declarationNames = new Set(["plugin.json", "sidecar.json", "environment.json", "exposure.json"]);

// 언어별 고정 루트를 두지 않는다. 한 패키지의 다른 언어도 모두 발견한다.
export function discoverInventory(files) {
  const implementations = [], tests = [], manifests = [], generated = [];
  for (const file of [...new Set(files)].sort()) {
    const excluded = [...GENERATED_ROOTS].find(([root]) => file.startsWith(root));
    if (excluded) {
      generated.push({ file, reason: excluded[1] });
      continue;
    }
    const name = file.split("/").at(-1);
    if (manifestNames.has(name)) manifests.push(file);
    const language = declarationNames.has(name) ? "declaration" : sourceLanguages.get(extname(file));
    if (!language) continue;
    const isTest = /(^|\/)(test|tests)\//.test(file) || /(^|\/)e2e\//.test(file) || /[._]test\.(mjs|js|cjs|ts|go|rs|m|mm)$/.test(file);
    (isTest ? tests : implementations).push({ file, language });
  }
  return { implementations, tests, manifests, generated };
}

function repositoryFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  }).split("\0").filter((file) => file && existsSync(`${ROOT}${file}`));
}

// 선언에 사용하는 *, **, ? 패턴만 확장한다.
function globRegex(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export function auditInventory(files, matrix = MATRIX) {
  const matches = new Map();
  const expand = (pattern) => {
    if (!matches.has(pattern)) {
      const regex = globRegex(pattern);
      matches.set(pattern, files.filter((file) => regex.test(file)));
    }
    return matches.get(pattern);
  };
  const unique = (patterns) => [...new Set(patterns.flatMap(expand))].sort();
  const extensionOf = (file) => extname(file);
  const errors = [];
  const warnings = [];
  const implementationOwners = new Map();
  const testOwners = new Map();
  const addOwner = (owners, file, entry, kind) => {
    const list = owners.get(file) ?? [];
    list.push(entry);
    owners.set(file, list);
    if (list.length > 1 && !(kind === "test" && list.every((item) => item.sharedTests))) {
      errors.push(`${file}: ${kind} is claimed by multiple matrix entries: ${list.map((item) => item.capability).join(", ")}`);
    }
  };

  for (const entry of matrix) {
    const implementations = unique(entry.implementation);
    const tests = unique(entry.tests);
    for (const pattern of entry.implementation) {
      if (expand(pattern).length === 0) errors.push(`${entry.capability} [${entry.language}]: implementation pattern matched no files: ${pattern}`);
    }
    for (const pattern of entry.tests) {
      if (expand(pattern).length === 0) errors.push(`${entry.capability} [${entry.language}]: test pattern matched no files: ${pattern}`);
    }
    if (implementations.length === 0 && entry.implementation.length === 0) {
      errors.push(`${entry.capability} [${entry.language}]: no implementation files`);
    }
    if (tests.length === 0 && entry.tests.length === 0) {
      errors.push(`${entry.capability} [${entry.language}]: no test files`);
    }

    const implementationExtensions = languages[entry.language];
    if (implementationExtensions) {
      for (const file of implementations) {
        if (!implementationExtensions.has(extensionOf(file))) {
          errors.push(`${file}: ${entry.capability} declares ${entry.language} but the implementation extension is not valid`);
        }
      }
    }
    const testExtensions = entry.testExtensions ?? languages[entry.testLanguage];
    if (testExtensions) {
      for (const file of tests) {
        if (!testExtensions.has(extensionOf(file))) {
          errors.push(`${file}: ${entry.capability} declares ${entry.testLanguage} tests but the test extension is not valid`);
        }
      }
    }
    for (const file of implementations) addOwner(implementationOwners, file, entry, "implementation");
    for (const file of tests) addOwner(testOwners, file, entry, "test");
  }

  const inventory = discoverInventory(files);
  for (const { file, language } of inventory.implementations) {
    if (!implementationOwners.has(file)) errors.push(`${file} [${language}]: implementation is not claimed by the test inventory`);
  }
  for (const { file, language } of inventory.tests) {
    if (!testOwners.has(file)) errors.push(`${file} [${language}]: test is not claimed by the test inventory`);
  }

  return { errors, warnings, inventory, trackCount: matrix.length, implementationCount: implementationOwners.size, testCount: testOwners.size };
}

export { MATRIX, repositoryFiles };

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { errors, warnings, trackCount, implementationCount, testCount } = auditInventory(repositoryFiles());
  if (errors.length) {
    console.error(`Test inventory checks failed: ${errors.length} issue(s)`);
    for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
    process.exitCode = 1;
  } else console.log(`Test inventory checks passed: ${trackCount} tracks, ${implementationCount} implementation files, ${testCount} test files. Structural evidence only; behavior was not executed.`);
  for (const warning of warnings) console.warn(`Warning: ${warning}`);
}
