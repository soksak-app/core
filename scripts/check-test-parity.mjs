// 구현·테스트 파일 소유를 검사한다. 이 구조 검사는 동작 검증을 대신하지 않는다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const languages = {
  "js-ts": new Set([".js", ".mjs", ".ts", ".tsx"]),
  rust: new Set([".rs"]),
  go: new Set([".go"]),
  "objective-c": new Set([".m"]),
  "native-interface": new Set([".h"]),
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
  lane("soksak utility scripts", "js-ts", [
    "packages/soksak/scripts/bounded.mjs",
    "packages/soksak/scripts/breaks.mjs",
    "packages/soksak/scripts/emit-dom-reference.mjs",
    "packages/soksak/scripts/fuzz.mjs",
  ], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("workspace audit scripts", "js-ts", [
    "scripts/check-boundaries.mjs",
    "scripts/check-e2e.mjs",
    "scripts/check-exposure.mjs",
    "scripts/sidecar-packages.mjs",
  ], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("build environment audit", "shell", ["scripts/check-build-environment.sh"], ["scripts/test/soksak-scripts.test.mjs"], {
    testLanguage: "js-ts", sharedTests: true,
  }),
  lane("break and mutation inventory", "js-ts", [
    "packages/soksak/scripts/check-breaks.mjs",
    "packages/soksak/scripts/mutate.mjs",
  ], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("host structure audit", "js-ts", ["scripts/check-hosts.mjs"], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("release diagnostic audit", "js-ts", ["scripts/check-release.mjs"], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("VT recovery verifier", "js-ts", ["scripts/verify-vt-recovery.mjs"], ["scripts/test/vt-recovery.test.mjs"]),
  lane("platform boundary audit", "js-ts", ["scripts/check-platforms.mjs"], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("plugin API", "js-ts", ["packages/plugin-api/*.js"], ["packages/plugin-api/test/**/*.mjs"]),
  lane("workbench", "js-ts", ["packages/workbench/*.js", "packages/workbench/*.mjs"], ["packages/workbench/test/**/*.js", "packages/workbench/test/**/*.mjs"], { sharedTests: true }),
  lane("client", "js-ts", [
    "packages/client/*.js",
    "packages/client/platform/**/*.js",
    "packages/client/testing/**/*.js",
    "packages/client/bench/**/*.mjs",
  ], ["packages/client/test/**/*.mjs"]),
  lane("CLI", "js-ts", ["packages/cli/**/*.js"], ["packages/cli/test/**/*.mjs"]),
  lane("MCP client", "js-ts", ["packages/mcp/**/*.js"], ["packages/mcp/test/**/*.mjs"]),
  lane("browser plugin", "js-ts", ["plugins/browser/ui/**/*.js"], ["plugins/browser/test/**/*.mjs"], { sharedTests: true }),
  lane("shell plugin", "js-ts", ["plugins/shell/ui/**/*.js"], ["plugins/shell/test/**/*.mjs"], { sharedTests: true }),
  lane("terminal plugin", "js-ts", ["plugins/terminal/ui/**/*.js"], ["plugins/terminal/test/**/*.mjs"], { sharedTests: true }),
  lane("browser runtime", "js-ts", ["apps/browser/runtime/**/*.js"], ["apps/browser/test/**/*.mjs"], { sharedTests: true }),
  lane("Tauri runtime", "js-ts", ["apps/tauriv2/runtime/**/*.js"], ["apps/tauriv2/test/**/*.mjs"], { sharedTests: true }),
  lane("Wails runtime", "js-ts", ["apps/wailsv3/runtime/**/*.js"], ["apps/wailsv3/test/**/*.mjs"], { sharedTests: true }),
  lane("files plugin declaration", "declaration", ["plugins/files/plugin.json"], ["plugins/files/test/manifest.test.mjs"], { testLanguage: "js-ts" }),

  lane("Tauri host", "rust", ["packages/host/tauriv2/src/**/*.rs", "packages/host/tauriv2/build.rs"], ["packages/host/tauriv2/tests/**/*.rs"]),
  lane("Tauri application bootstrap", "rust", ["apps/tauriv2/src/main.rs", "apps/tauriv2/build.rs"], ["e2e/**/*.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("VT core", "rust", ["sidecars/vt-core/src/**/*.rs", "sidecars/vt-core/build.rs"], ["sidecars/vt-core/tests/**/*.rs"], { sharedTests: true }),
  lane("VT Alacritty sidecar", "rust", ["sidecars/vt-alacritty/src/**/*.rs"], ["sidecars/vt-alacritty/tests/**/*.rs"]),

  lane("Wails host", "go", ["packages/host/wailsv3/src/**/*.go"], ["packages/host/wailsv3/tests/**/*.go", "packages/host/wailsv3/src/diagnostics_test.go"], { sharedTests: true }),
  lane("Wails application bootstrap", "go", ["apps/wailsv3/src/main.go"], ["e2e/**/*.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("shell sidecar", "go", ["sidecars/shell/src/**/*.go"], ["sidecars/shell/tests/**/*.go", "sidecars/shell/tests/**/*.mjs"], {
    testLanguage: "mixed",
    testExtensions: new Set([".go", ".mjs"]),
    sharedTests: true,
  }),

  lane("Darwin clipboard", "objective-c", ["native/darwin/src/clipboard.m"], ["native/darwin/tests/clipboard_test.m"], { sharedTests: true }),
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
  ], { sharedTests: true }),
  lane("Darwin input", "objective-c", [
    "native/darwin/src/input_inject.m",
    "native/darwin/src/webview_input.m",
  ], [
    "native/darwin/tests/input_activate_test.m",
    "native/darwin/tests/input_inject_test.m",
    "native/darwin/tests/webview_focus_test.m",
    "native/darwin/tests/webview_input_test.m",
  ], { sharedTests: true }),
  lane("Darwin window", "objective-c", ["native/darwin/src/window_*.m"], ["native/darwin/tests/window_*_test.m"], { sharedTests: true }),
  lane("Darwin UI queue", "objective-c", ["native/darwin/src/ui_queue.m"], ["native/darwin/tests/ui_queue_test.m"], { sharedTests: true }),
  lane("Darwin capture", "objective-c", ["native/darwin/src/capture.m"], ["native/darwin/tests/capture_test.m"], { sharedTests: true }),
  lane("Darwin dock menu", "objective-c", ["native/darwin/src/dock_menu.m"], ["native/darwin/tests/dock_menu_test.m"], { sharedTests: true }),
  lane("Darwin appearance", "objective-c", ["native/darwin/src/appearance.m"], ["native/darwin/tests/appearance_test.m"], { sharedTests: true }),
  lane("Darwin native interfaces", "native-interface", ["native/darwin/src/**/*.h"], ["native/darwin/tests/**/*.m"], { testLanguage: "objective-c", sharedTests: true }),
  lane("VT Darwin frame interface", "native-interface", ["sidecars/vt-core/src/platform/darwin/frame.h"], ["sidecars/vt-core/tests/frame_test.rs"], { testLanguage: "rust", sharedTests: true }),
  lane("VT Darwin frame implementation", "objective-c", ["sidecars/vt-core/src/platform/darwin/frame.m"], ["sidecars/vt-core/tests/frame_test.rs"], { testLanguage: "rust", sharedTests: true }),
  lane("browser environment declaration", "declaration", ["apps/browser/environment.json"], ["apps/browser/test/environment.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Tauri environment declaration", "declaration", ["apps/tauriv2/environment.json"], ["apps/tauriv2/test/environment.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Wails environment declaration", "declaration", ["apps/wailsv3/environment.json"], ["apps/wailsv3/test/environment.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Plugin declarations", "declaration", ["plugins/browser/plugin.json", "plugins/shell/plugin.json", "plugins/terminal/plugin.json"], [
    "plugins/browser/test/manifest.test.mjs", "plugins/shell/test/manifest.test.mjs", "plugins/terminal/test/manifest.test.mjs",
  ], { testLanguage: "js-ts", sharedTests: true }),
  lane("Sidecar declarations", "declaration", ["sidecars/shell/sidecar.json", "sidecars/vt-alacritty/sidecar.json"], [
    "sidecars/shell/tests/sidecar_test.mjs", "packages/workbench/test/sidecar-packages.test.mjs",
  ], { testLanguage: "js-ts", sharedTests: true }),
  lane("Wails bridge", "js-ts", ["packages/host/wailsv3/src/bridge.js"], ["apps/wailsv3/test/runtime-contract.test.mjs"], { sharedTests: true }),
  lane("Wails native webview bridge", "objective-c", ["packages/host/wailsv3/src/platform/darwin/webview.m"], ["packages/host/wailsv3/tests/documents_test.go"], { testLanguage: "go", sharedTests: true }),
  lane("Workbench styles", "stylesheet", ["packages/workbench/app.css", "packages/workbench/library.css"], ["packages/workbench/test/background.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Workbench declarations", "declaration", ["packages/workbench/exposure.json"], ["packages/workbench/test/exposure.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Workbench documents", "document", ["packages/workbench/index.html", "packages/workbench/overlay.html"], ["packages/workbench/test/published-imports.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
];

// A feature link is stronger than a file owner: it names the implementation,
// behavior test, expected result, and verification levels for one capability.
// The inventory remains structural; behavior is proved by the referenced tests.
const FEATURE_LINKS = [
  {
    id: "F0.1",
    implementation: [
      { file: "native/darwin/src/input_inject.m", symbol: "sp_input_pointer" },
      { file: "packages/host/tauriv2/src/platform/darwin/input.rs", symbol: "pointer" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "three terminal" },
      { file: "native/darwin/tests/input_inject_test.m", id: "keys reach the focused field" },
    ],
    expected: "Native input reaches each of three terminal surfaces with exact focus, text, Enter, and isolation behavior.",
    levels: ["native", "application"],
  },
  {
    id: "F0.1.2",
    implementation: [
      { file: "plugins/terminal/ui/terminal.js", symbol: "terminal.focus" },
      { file: "native/darwin/src/webview_input.m", symbol: "webviewInputSendThen" },
    ],
    tests: [
      { file: "plugins/terminal/test/terminal.test.mjs", id: "pointerdown prevents DOM focus" },
      { file: "native/darwin/tests/input_inject_test.m", id: "a click focuses the field" },
    ],
    expected: "The first native click focuses a terminal and the next character is accepted without a second click.",
    levels: ["unit", "native", "application"],
  },
  {
    id: "F0.1.3",
    implementation: [
      { file: "plugins/browser/ui/browser.js", symbol: "browser.address.select" },
      { file: "native/darwin/src/input_inject.m", symbol: "sp_input_key" },
    ],
    tests: [
      { file: "plugins/browser/test/address-input.test.mjs", id: "initial address focus selects all" },
      { file: "e2e/browser.test.mjs", id: "browser document region navigates" },
    ],
    expected: "The first address entry replaces the selected URL instead of appending to it, while later clicks retain caret editing.",
    levels: ["unit", "application"],
  },
  {
    id: "F0.2",
    implementation: [
      { file: "native/darwin/src/appearance.m", symbol: "sp_webview_set_appearance" },
      { file: "packages/host/tauriv2/src/platform/darwin/webview.rs", symbol: "sp_webview_set_appearance" },
    ],
    tests: [
      { file: "native/darwin/tests/appearance_test.m", id: "dark appearance is applied" },
      { file: "apps/tauriv2/test/runtime-contract.test.mjs", id: "composition places geometry" },
    ],
    expected: "Dark and light appearance assignment uses the compiled native helper and rejects a null view explicitly.",
    levels: ["unit", "native", "application"],
  },
  {
    id: "F0.3",
    implementation: [
      { file: "sidecars/shell/src/shell/shell.go", symbol: "handle" },
      { file: "sidecars/shell/src/platform/platform.go", symbol: "DirectoryMarker" },
    ],
    tests: [
      { file: "sidecars/shell/tests/serve_test.go", id: "TestReopenReportsTheLiveDirectoryToARemountedSurface" },
      { file: "e2e/shell.test.mjs", id: "remounted shell surface replays its live directory" },
    ],
    expected: "Reopening a mounted shell reports the live session directory without inventing a default directory or duplicating output.",
    levels: ["unit", "application"],
  },
  {
    id: "F0.4",
    implementation: [
      { file: "native/darwin/src/input_inject.m", symbol: "webviewInputSendThen" },
      { file: "native/darwin/src/webview_input.m", symbol: "webviewInputSendThen" },
      { file: "packages/host/wailsv3/src/platform/darwin/input.go", symbol: "pointerSequence" },
    ],
    tests: [
      { file: "native/darwin/tests/input_inject_test.m", id: "A focused input can leave WebKit work queued" },
      { file: "e2e/shell.test.mjs", id: "shell commands run, report the directory, interrupt, and clear" },
    ],
    expected: "A shell command returns its exact output and exit status on both macOS hosts after native pointer input.",
    levels: ["unit", "native", "application"],
  },
  {
    id: "F2.1",
    implementation: [{ file: "sidecars/vt-core/src/pty.rs", symbol: "pub fn close" }],
    tests: [{ file: "sidecars/vt-core/tests/pty_lifecycle.rs", id: "real_sessions_are_independent_and_close_removes_session" }],
    expected: "Closing a PTY terminates its child process group and drains the reader without retaining the session.",
    levels: ["unit", "native"],
  },
  {
    id: "F2.2",
    implementation: [
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "shutdown_waiters" },
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "CloseOwner" },
    ],
    tests: [{ file: "e2e/terminal-processes.test.mjs", id: "process measurement preserves identities" }],
    expected: "Normal application quit acknowledges owned-session closure, stops the service, and removes its endpoint.",
    levels: ["application"],
  },
  {
    id: "F2.3",
    implementation: [
      { file: "sidecars/vt-core/src/pty.rs", symbol: "close_owner" },
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "Close" },
    ],
    tests: [{ file: "e2e/terminal-processes.test.mjs", id: "process measurement preserves identities" }],
    expected: "Closing terminal tabs reaps their PTY children while retaining the shared terminal service.",
    levels: ["native", "application"],
  },
  {
    id: "F2.4",
    implementation: [{ file: "sidecars/vt-core/src/platform/darwin/service.rs", symbol: "serve_persistent" }],
    tests: [
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "persistent_transport_reconnects_after_connection_loss_and_preserves_owner" },
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentTransportHarnessEndpointAuthConcurrentReconnectAndCloseAck" },
    ],
    expected: "A client connection loss reconnects to the persistent service while preserving the owning surface identity.",
    levels: ["native"],
  },
  {
    id: "F2.4-1",
    implementation: [{ file: "sidecars/vt-core/src/platform/darwin/service.rs", symbol: "serve_persistent" }],
    tests: [{ file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "persistent_transport_reconnects_after_connection_loss_and_preserves_owner" }],
    expected: "The reconnect case has its own five-second bound and reports timeout as failure under concurrent test load.",
    levels: ["native"],
  },
  {
    id: "F2.5",
    implementation: [{ file: "sidecars/vt-core/src/protocol.rs", symbol: "close_owner" }],
    tests: [{ file: "sidecars/vt-core/tests/pty_lifecycle.rs", id: "three_real_sessions_reconnect_with_same_pid_and_retained_output" }],
    expected: "Closing one owner's sessions leaves another owner's session addressable until that owner closes it.",
    levels: ["unit", "native"],
  },
  {
    id: "F2.6",
    implementation: [
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "service_process_exists" },
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "NewSidecars" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "persistent_transport_replaces_endpoint_left_by_a_dead_service" },
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentTransportReplacesEndpointLeftByDeadService" },
    ],
    expected: "A dead service endpoint is replaced through authenticated bootstrap and routes requests to the new service.",
    levels: ["native"],
  },
  {
    id: "F2.7",
    implementation: [
      { file: "packages/host/tauriv2/src/endpoint.rs", symbol: "pub fn connect" },
      { file: "packages/host/wailsv3/src/endpoint.go", symbol: "NewEndpoint" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "persistent_transport_reports_live_but_unreachable_endpoint_without_replacement" },
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentTransportReportsLiveButUnreachableEndpointWithoutReplacement" },
    ],
    expected: "A live but unreachable endpoint returns an explicit connection error and its endpoint record remains byte-for-byte unchanged.",
    levels: ["native"],
  },
  {
    id: "F2.8",
    implementation: [{ file: "sidecars/vt-core/src/platform/darwin/service.rs", symbol: "serve_persistent" }],
    tests: [{ file: "scripts/verify-vt-recovery.mjs", id: "retained_screen_contains_RECOVERY" }],
    expected: "The rebuilt persistent service survives transport loss, reattaches the same session, and retains output.",
    levels: ["native"],
  },
  {
    id: "F2.9",
    implementation: [{ file: "scripts/verify-vt-recovery.mjs", symbol: "recovery_check_duration_ms" }],
    tests: [{ file: "scripts/verify-vt-recovery.mjs", id: "recovery_check_duration_ms" }],
    expected: "Recovery reports per-step results, duration, and explicit service cleanup within bounded execution.",
    levels: ["native"],
  },
  {
    id: "F2.10",
    implementation: [{ file: "scripts/verify-vt-recovery.mjs", symbol: "application_process_restarted" }],
    tests: [{ file: "scripts/verify-vt-recovery.mjs", id: "application_process_restarted" }],
    expected: "A client process that exits without close-owner can be replaced and reconnect to the same retained session.",
    levels: ["native"],
  },
  {
    id: "F2.11",
    implementation: [
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "protocol mismatch" },
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "protocol mismatch" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "persistent_transport_rejects_unsupported_hello_protocol_without_replacing_endpoint" },
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentTransportRejectsUnsupportedHelloProtocolWithoutReplacingEndpoint" },
    ],
    expected: "An unsupported service protocol is rejected explicitly and does not replace the endpoint record.",
    levels: ["native"],
  },
  {
    id: "F2.2-1",
    implementation: [{ file: "e2e/normal-shutdown.mjs", symbol: "command.run" }],
    tests: [{ file: "e2e/normal-shutdown.mjs", id: "normal-shutdown" }],
    expected: "A declared command.run host.quit request returns null and removes the application PID and endpoint within the bounded case limit.",
    levels: ["application"],
  },
  {
    id: "F1.3",
    implementation: [{ file: "e2e/terminal.test.mjs", symbol: "roundTripsPerSet" }],
    tests: [{ file: "e2e/terminal.test.mjs", id: "three terminals survive repeated divider drags and project returns" }],
    expected: "Three visible terminals complete six narrow-to-wide-and-back divider round trips in each of three project-return sets, with complete captures, no border intrusion, no white pixels, and no composition failure.",
    levels: ["application"],
  },
  {
    id: "G1.1",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "discoverInventory" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "discovery includes nested languages" }],
    expected: "The inventory discovers nested implementation and test languages without fixed package roots and reports omissions.",
    levels: ["unit"],
  },
  {
    id: "G1.2",
    implementation: [
      { file: "sidecars/vt-core/package.json", symbol: "cargo test" },
      { file: "sidecars/vt-alacritty/package.json", symbol: "cargo test" },
    ],
    tests: [{ file: "scripts/test/package-test-command.test.mjs", id: "package test executes Rust tests" }],
    expected: "Each terminal sidecar invokes its Rust test command and propagates a failing command result.",
    levels: ["unit", "native"],
  },
  {
    id: "G1.2-1",
    implementation: [{ file: "scripts/test-command.mjs", symbol: "timeoutMs" }],
    tests: [{ file: "scripts/test/test-command.test.mjs", id: "rejects invalid arguments" }],
    expected: "Invalid supervisor limits fail explicitly and no compatibility timeout path is used.",
    levels: ["unit"],
  },
  {
    id: "G1.3",
    implementation: [{ file: "scripts/checklist.mjs", symbol: "checkCompletedItems" }],
    tests: [{ file: "scripts/test/checklist.test.mjs", id: "checklist preserves completed scope" }],
    expected: "Checklist translations and completed identifiers remain structurally synchronized and cannot be silently reopened.",
    levels: ["unit"],
  },
  {
    id: "G4.1",
    implementation: [{ file: "scripts/test-command.mjs", symbol: "runCommand" }],
    tests: [{ file: "scripts/test/test-command.test.mjs", id: "emits ordered start and terminal events" }],
    expected: "Supervised commands emit attributable start/progress/final events, visible output, bounded failure, and cleanup results.",
    levels: ["unit"],
  },
  {
    id: "F1.1",
    implementation: [
      { file: "packages/host/tauriv2/src/surfaces.rs", symbol: "pub(crate) fn aligned" },
      { file: "e2e/drag-measurement.mjs", symbol: "assertRoundTrips" },
    ],
    tests: [
      { file: "e2e/outside.test.mjs", id: "native content, cards, and the sidebar rail stay aligned" },
      { file: "e2e/outside.test.mjs", id: "shell divider drag does not leave a white surface frame" },
    ],
    expected: "A complete divider recording keeps native content inside its card, keeps card and rail geometry aligned, contains no white surface frame, and returns to its initial position.",
    levels: ["native", "application"],
  },
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
  const uncoveredImplementations = inventory.implementations.filter(({ file }) => !implementationOwners.has(file));
  const uncoveredTests = inventory.tests.filter(({ file }) => !testOwners.has(file));
  for (const { file, language } of uncoveredImplementations) {
    errors.push(`${file} [${language}]: implementation is not claimed by the test inventory`);
  }
  for (const { file, language } of uncoveredTests) {
    errors.push(`${file} [${language}]: test is not claimed by the test inventory`);
  }

  const featureErrors = auditFeatureLinks(FEATURE_LINKS, files);
  errors.push(...featureErrors);

  return {
    errors,
    warnings,
    inventory,
    uncoveredImplementations,
    uncoveredTests,
    featureErrors,
    featureLinks: FEATURE_LINKS,
    trackCount: matrix.length,
    implementationCount: implementationOwners.size,
    testCount: testOwners.size,
  };
}

export function auditFeatureLinks(features, files, readSource = (file) => readFileSync(`${ROOT}${file}`, "utf8")) {
  const knownFiles = new Set(files);
  const errors = [];
  const ids = new Set();
  const levels = new Set(["unit", "native", "application", "release"]);
  for (const feature of features) {
    if (!feature.id || ids.has(feature.id)) {
      errors.push(`${feature.id || "<missing>"}: feature link id is missing or duplicated`);
    }
    ids.add(feature.id);
    if (!feature.expected?.trim()) errors.push(`${feature.id}: feature link has no expected result`);
    if (!Array.isArray(feature.levels) || feature.levels.length === 0 || feature.levels.some((level) => !levels.has(level))) {
      errors.push(`${feature.id}: feature link has an invalid verification level`);
    }
    for (const implementation of feature.implementation ?? []) {
      if (!implementation.file || !implementation.symbol) errors.push(`${feature.id}: implementation link must name a file and symbol`);
      else if (!knownFiles.has(implementation.file)) errors.push(`${feature.id}: implementation file is not in the workspace: ${implementation.file}`);
      else {
        let source;
        try { source = readSource(implementation.file); }
        catch { source = null; }
        if (source === null) errors.push(`${feature.id}: implementation source cannot be read: ${implementation.file}`);
        else if (!source.includes(implementation.symbol)) errors.push(`${feature.id}: implementation symbol is not present in ${implementation.file}: ${implementation.symbol}`);
      }
    }
    for (const test of feature.tests ?? []) {
      if (!test.file || !test.id) errors.push(`${feature.id}: behavior test link must name a file and test id`);
      else if (!knownFiles.has(test.file)) errors.push(`${feature.id}: behavior test file is not in the workspace: ${test.file}`);
      else {
        let source;
        try { source = readSource(test.file); }
        catch { source = null; }
        if (source === null) errors.push(`${feature.id}: behavior test source cannot be read: ${test.file}`);
        else if (!source.includes(test.id)) errors.push(`${feature.id}: behavior test id is not present in ${test.file}: ${test.id}`);
      }
    }
    if (!feature.implementation?.length) errors.push(`${feature.id}: feature link has no implementation entry`);
    if (!feature.tests?.length) errors.push(`${feature.id}: feature link has no behavior test entry`);
  }
  return errors;
}

export { MATRIX, repositoryFiles };

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { errors, warnings, uncoveredImplementations, uncoveredTests, featureErrors, featureLinks, trackCount, implementationCount, testCount } = auditInventory(repositoryFiles());
  if (errors.length) {
    console.error(`Test inventory checks failed: ${errors.length} issue(s); ` +
      `${uncoveredImplementations.length} uncovered implementation(s), ${uncoveredTests.length} uncovered test(s), ` +
      `${featureErrors.length} feature-link issue(s); ${featureLinks.length} feature link(s) inspected`);
    if (uncoveredImplementations.length) {
      console.error('Uncovered implementations:');
      for (const { file, language } of uncoveredImplementations.sort((a, b) => a.file.localeCompare(b.file))) {
        console.error(`- ${file} [${language}]`);
      }
    }
    if (uncoveredTests.length) {
      console.error('Uncovered tests:');
      for (const { file, language } of uncoveredTests.sort((a, b) => a.file.localeCompare(b.file))) {
        console.error(`- ${file} [${language}]`);
      }
    }
    if (featureErrors.length) {
      console.error('Feature-link errors:');
      for (const error of featureErrors.sort()) console.error(`- ${error}`);
    }
    console.error('All audit errors:');
    for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
    process.exitCode = 1;
  } else console.log(`Test inventory checks passed: ${trackCount} tracks, ${implementationCount} implementation files, ${testCount} test files. Structural evidence only; behavior was not executed.`);
  for (const warning of warnings) console.warn(`Warning: ${warning}`);
}
