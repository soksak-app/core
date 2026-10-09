// 구현·테스트 파일 소유를 검사한다. 이 구조 검사는 동작 검증을 대신하지 않는다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const languages = {
  "js-ts": new Set([".js", ".mjs", ".ts", ".tsx"]),
  rust: new Set([".rs"]),
  go: new Set([".go"]),
  "objective-c": new Set([".m"]),
  "native-interface": new Set([".h"]),
  declaration: new Set([".json"]),
  // 빌드 선언은 확장자가 없는 Makefile 이다.
  build: new Set(["Makefile"]),
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
  lane("Makefile check targets", "build", ["Makefile"], ["scripts/test/language-repeat.test.mjs", "scripts/test/node-repeat.test.mjs", "scripts/test/windows-build-check.test.mjs"], { testLanguage: "js-ts" }),
  lane("native library pkg-config", "build", ["native/darwin/Makefile"], ["scripts/test/native-pkgconfig.test.mjs"], { testLanguage: "js-ts" }),
  lane("workspace audit scripts", "js-ts", [
    "scripts/check-boundaries.mjs",
    "scripts/check-e2e.mjs",
    "scripts/check-e2e-host-parity.mjs",
    "scripts/check-exposure.mjs",
    "scripts/check-host-parity.mjs",
  ], ["scripts/test/soksak-scripts.test.mjs", "scripts/test/e2e-host-parity.test.mjs", "scripts/test/check-host-parity.test.mjs", "scripts/test/check-exposure.test.mjs"], { sharedTests: true }),
  lane("test inventory", "js-ts", ["scripts/check-test-parity.mjs"], ["scripts/test/test-parity.test.mjs"]),
  lane("host contract audit", "js-ts", ["scripts/check-host-contract.mjs"], ["scripts/test/check-host-contract.test.mjs"]),
lane("command supervision", "js-ts", ["scripts/test-command.mjs"], ["scripts/test/test-command.test.mjs"]),
lane("language test adapters", "js-ts", ["scripts/language-test-adapters.mjs"], ["scripts/test/test-language-test-adapters.test.mjs"]),
lane("language test adapter manifest", "declaration", ["scripts/language-test-cases.json"], ["scripts/test/test-language-test-manifest.test.mjs"], { testLanguage: "js-ts" }),
lane("test evidence", "js-ts", ["scripts/test-evidence.mjs"], ["scripts/test/test-evidence.test.mjs"]),
  lane("workspace version audit", "js-ts", ["scripts/check-versions.mjs"], ["scripts/test/versions.test.mjs"]),
  lane("fallback and discarded error audit", "js-ts", ["scripts/check-fallbacks.mjs"], ["scripts/test/fallbacks.test.mjs"]),
  lane("comment language audit", "js-ts", ["scripts/check-comment-language.mjs"], ["scripts/test/comment-language.test.mjs"]),
  lane("registry manifest release check", "js-ts", ["scripts/check-registry-manifests.mjs"], ["scripts/test/registry-manifests.test.mjs"]),
  lane("documentation and checklist checks", "js-ts", ["scripts/check-docs.mjs", "scripts/checklist.mjs"], ["scripts/test/checklist.test.mjs"]),
  lane("soksak layout", "js-ts", ["packages/soksak/src/**/*.ts"], ["packages/soksak/test/**/*.mjs"]),
  lane("soksak utility scripts", "js-ts", [
    "packages/soksak/scripts/bounded.mjs",
    "packages/soksak/scripts/breaks.mjs",
    "packages/soksak/scripts/emit-dom-reference.mjs",
    "packages/soksak/scripts/fuzz.mjs",
  ], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("build environment audit", "shell", ["scripts/check-build-environment.sh"], ["scripts/test/soksak-scripts.test.mjs", "scripts/test/check-build-environment.sh"], {
    testLanguage: "js-ts", testExtensions: new Set([".mjs", ".sh"]), sharedTests: true,
  }),
  lane("break and mutation inventory", "js-ts", [
    "packages/soksak/scripts/check-breaks.mjs",
    "packages/soksak/scripts/mutate.mjs",
  ], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("host structure audit", "js-ts", ["scripts/check-hosts.mjs"], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("release diagnostic audit", "js-ts", ["scripts/check-release.mjs"], ["scripts/test/soksak-scripts.test.mjs", "scripts/test/check-release-paths.test.mjs"], { sharedTests: true }),
  lane("page memory measurement", "js-ts", ["scripts/measure-page-memory.mjs"], ["scripts/test/measure-page-memory.test.mjs"]),
  lane("application update check", "js-ts", ["scripts/check-app-update.mjs"], ["scripts/test/check-app-update.test.mjs"]),
  lane("workspace registry", "js-ts", ["scripts/workspace-registry.mjs"], ["scripts/test/workspace-registry.test.mjs"]),
  lane("platform boundary audit", "js-ts", ["scripts/check-platforms.mjs"], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("plugin API", "js-ts", ["packages/plugin-api/*.js"], ["packages/plugin-api/test/**/*.mjs"]),
  lane("workbench", "js-ts", ["packages/workbench/*.js", "packages/workbench/*.mjs"], ["packages/workbench/test/**/*.js", "packages/workbench/test/**/*.mjs"], { sharedTests: true }),
  lane("client", "js-ts", [
    "packages/client/*.js",
    "packages/client/platform/**/*.js",
    "packages/client/testing/**/*.js",
    "packages/client/bench/**/*.mjs",
  ], ["packages/client/test/**/*.mjs"]),
  lane("MCP client", "js-ts", ["packages/mcp/**/*.js"], ["packages/mcp/test/**/*.mjs"]),
  lane("window check harness", "js-ts", ["packages/window-check/*.mjs"], ["packages/window-check/test/**/*.mjs"]),
  lane("browser runtime", "js-ts", ["apps/browser/runtime/**/*.js"], ["apps/browser/test/**/*.mjs", "apps/browser/check/**/*.mjs"], { sharedTests: true }),
  lane("Tauri runtime", "js-ts", ["apps/tauriv2/runtime/**/*.js"], ["apps/tauriv2/test/**/*.mjs"], { sharedTests: true }),
  lane("Wails runtime", "js-ts", ["apps/wailsv3/runtime/**/*.js"], ["apps/wailsv3/test/**/*.mjs"], { sharedTests: true }),

  lane("Tauri host", "rust", ["packages/host/tauriv2/src/**/*.rs", "packages/host/tauriv2/build.rs"], ["packages/host/tauriv2/tests/**/*.rs", "packages/host/tauriv2/tests/fixtures/**/*.json"], { testExtensions: new Set([".rs", ".json"]) }),
  lane("Tauri application bootstrap", "rust", ["apps/tauriv2/src/main.rs", "apps/tauriv2/build.rs"], ["e2e/**/*.mjs"], { testLanguage: "js-ts", sharedTests: true }),

  lane("Wails host", "go", ["packages/host/wailsv3/src/**/*.go"], ["packages/host/wailsv3/tests/**/*.go", "packages/host/wailsv3/tests/fixtures/**/*.json", "packages/host/wailsv3/src/diagnostics_test.go"], { sharedTests: true, testExtensions: new Set([".go", ".json"]) }),
  lane("Wails command line", "go", ["packages/sok/wailsv3/src/**/*.go"], ["packages/sok/wailsv3/tests/**/*.go", "packages/sok/wailsv3/src/diagnostics_test.go", "packages/sok/wailsv3/src/dev_test.go"]),
  lane("Tauri command line", "rust", ["packages/sok/tauriv2/src/**/*.rs"], ["packages/sok/tauriv2/tests/**/*.rs"]),
  lane("Wails application bootstrap", "go", ["apps/wailsv3/src/main.go"], ["e2e/**/*.mjs"], { testLanguage: "js-ts", sharedTests: true }),

  lane("Darwin clipboard", "objective-c", ["native/darwin/src/clipboard.m"], ["native/darwin/tests/clipboard_test.m"], { sharedTests: true }),
  lane("Darwin link open", "objective-c", ["native/darwin/src/link.m"], ["native/darwin/tests/link_test.m"], { sharedTests: true }),
  lane("Darwin notifications", "objective-c", ["native/darwin/src/notifications.m"], ["native/darwin/tests/notifications_test.m"], { sharedTests: true }),
  lane("Darwin document and surface", "objective-c", [
    "native/darwin/src/document_view.m",
    "native/darwin/src/image_region.m",
    "native/darwin/src/surface_layout.m",
    "native/darwin/src/webview_geometry.m",
  ], [
    "native/darwin/tests/document_view_test.m",
    "native/darwin/tests/image_region_test.m",
    "native/darwin/tests/presentation_order_test.m",
    "native/darwin/tests/surface_layout_test.m",
    "native/darwin/tests/webview_geometry_test.m",
    "native/darwin/tests/window_cursor_rects_test.m",
    "native/darwin/tests/webview_inspector_test.m",
    "native/darwin/tests/surface_host_test.m",
  ], { sharedTests: true }),
  lane("Darwin input", "objective-c", [
    "native/darwin/src/input_inject.m",
    "native/darwin/src/input_source.m",
    "native/darwin/src/webview_input.m",
  ], [
    "native/darwin/tests/image_region_ime_test.m",
    "native/darwin/tests/input_activate_test.m",
    "native/darwin/tests/input_inject_test.m",
    "native/darwin/tests/webview_focus_test.m",
    "native/darwin/tests/webview_input_test.m",
  ], { sharedTests: true }),
  lane("Darwin window", "objective-c", ["native/darwin/src/window_*.m"], ["native/darwin/tests/window_*_test.m"], { sharedTests: true }),
  lane("Darwin UI queue", "objective-c", ["native/darwin/src/ui_queue.m"], ["native/darwin/tests/ui_queue_test.m"], { sharedTests: true }),
  lane("Darwin process exit", "objective-c", ["native/darwin/src/process_exit.m"], ["native/darwin/tests/process_exit_test.m"], { sharedTests: true }),
  lane("Darwin application log", "objective-c", ["native/darwin/src/application_log.m"], ["native/darwin/tests/application_log_test.m"], { sharedTests: true }),
  lane("Darwin mouse buttons", "objective-c", ["native/darwin/src/mouse_buttons.m"], ["native/darwin/tests/mouse_buttons_test.m"], { sharedTests: true }),
  lane("Darwin quit request", "objective-c", ["native/darwin/src/quit_request.m"], ["native/darwin/tests/quit_request_test.m"], { sharedTests: true }),
  lane("Darwin webview navigation", "objective-c", ["native/darwin/src/webview_navigation.m"], ["native/darwin/tests/webview_navigation_test.m"], { sharedTests: true }),
  lane("Darwin capture", "objective-c", ["native/darwin/src/capture.m"], ["native/darwin/tests/capture_test.m", "native/darwin/tests/capture_pressure_test.m", "native/darwin/tests/capture_metadata_test.m", "native/darwin/tests/capture_resize_test.m", "native/darwin/tests/capture_checker_test.m", "native/darwin/tests/capture_file_checker_test.m", "native/darwin/tests/capture_storage_test.m", "native/darwin/tests/capture_frame_test.m", "native/darwin/tests/capture_lifecycle_test.m", "native/darwin/tests/capture_preparation_test.m", "native/darwin/tests/capture_cleanup_test.m", "native/darwin/tests/capture_callback_test.m"], { sharedTests: true }),
  lane("Darwin dock menu", "objective-c", ["native/darwin/src/dock_menu.m"], ["native/darwin/tests/dock_menu_test.m"], { sharedTests: true }),
  lane("Darwin appearance", "objective-c", ["native/darwin/src/appearance.m"], ["native/darwin/tests/appearance_test.m"], { sharedTests: true }),
  lane("Darwin native interfaces", "native-interface", ["native/darwin/src/**/*.h"], ["native/darwin/tests/**/*.m"], { testLanguage: "objective-c", sharedTests: true }),
  lane("browser environment declaration", "declaration", ["apps/browser/environment.json"], ["apps/browser/test/environment.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Tauri environment declaration", "declaration", ["apps/tauriv2/environment.json"], ["apps/tauriv2/test/environment.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Wails environment declaration", "declaration", ["apps/wailsv3/environment.json"], ["apps/wailsv3/test/environment.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Wails bridge", "js-ts", ["packages/host/wailsv3/src/bridge.js"], ["apps/wailsv3/test/runtime-contract.test.mjs"], { sharedTests: true }),
  lane("Wails native webview bridge", "objective-c", ["packages/host/wailsv3/src/platform/darwin/webview.m"], ["packages/host/wailsv3/tests/documents_test.go"], { testLanguage: "go", sharedTests: true }),
  lane("Workbench styles", "stylesheet", ["packages/workbench/app.css", "packages/workbench/library.css"], ["packages/workbench/test/background.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Workbench declarations", "declaration", ["packages/workbench/exposure.json"], ["packages/workbench/test/exposure.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Workbench documents", "document", ["packages/workbench/index.html", "packages/workbench/overlay.html"], ["packages/workbench/test/published-imports.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
];

// feature 링크는 파일 소유자보다 강하다: 한 기능의 구현, behavior 테스트,
// 기대 결과, 검증 수준을 지명한다.
// inventory는 구조적으로 남고, behavior는 참조된 테스트가 증명한다.
const FEATURE_LINKS = [
  {
    id: "V5-118",
    implementation: [{ file: "packages/workbench/plane.js", symbol: "export function toggleCardFullscreen" }],
    tests: [
      { file: "packages/workbench/test/card-fullscreen.test.mjs", id: "the header fullscreen control precedes close and runs its declared command" },
      { file: "e2e/card-fullscreen.test.mjs", id: "card fullscreen fills the work area and restores live surfaces" },
    ],
    expected: "The fullscreen control before close fills the work area with the selected content card through its declared command and restores the arrangement and live sibling surfaces without OS fullscreen or saved-layout changes.",
    levels: ["unit", "application"],
  },
  {
    id: "V5-118-1",
    implementation: [{ file: "packages/workbench/plane.js", symbol: "export const presentedCardRect" }],
    tests: [{ file: "e2e/card-fullscreen.test.mjs", id: "sidebar settings apply to fullscreen and restored cards" }],
    expected: "Saved sidebar settings of a fullscreen card produce the same selected sets, section DOM and native content rectangle in fullscreen and after restoration.",
    levels: ["application"],
  },
  {
    id: "F0.4-1",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditFailureMatrix" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "failure matrix preserves JS/TS, Rust, Go, and Objective-C lane attribution" }],
    expected: "The complete failure-propagation audit covers every declared JS/TS, Rust, Go, and Objective-C production lane with attributable errors and no ignored outcomes.",
    levels: ["unit", "native"],
  },
  {
    id: "F0.4-1.1",
    implementation: [
      { file: "packages/host/wailsv3/src/surfaces.go", symbol: "CreateLogicalSurfaceHandle" },
      { file: "packages/host/wailsv3/src/modals.go", symbol: "alignErr" },
    ],
    tests: [{ file: "packages/host/wailsv3/tests/surface_activation_test.go", id: "TestLogicalSurfaceCreationPropagatesNativeFailure" }],
    expected: "Wails surface creation and alignment failures return attributable errors, reject nil native handles, cancel the pending layout, and do not continue as a successful partial surface update.",
    levels: ["native"],
  },
  {
    id: "G1",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditInventory" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "inventory reports uncovered implementations and tests as separate results" }],
    expected: "The workspace inventory reports implementation and test ownership separately, rejects uncovered files, and preserves structural evidence without claiming behavior coverage.",
    levels: ["unit"],
  },
  {
    id: "G2-1",
    implementation: [{ file: "scripts/check-hosts.mjs", symbol: "PAIRS" }],
    tests: [{ file: "scripts/test/soksak-scripts.test.mjs", id: "host structure audit reports a clean paired-host graph" }],
    expected: "The paired Tauri/Wails host and application structure contains only declared differences and no missing counterpart or obsolete process path.",
    levels: ["unit"],
  },
  {
    id: "G2-2",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditCompletedFeatureLinks" }, { file: "scripts/check-test-parity.mjs", symbol: "auditRecordedInventoryCounts" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "completed capability entries all have feature evidence links" }, { file: "scripts/test/test-parity.test.mjs", id: "recorded parity counts cannot drift from the current inventory" }],
    expected: "Completed host-structure and parity-correction entries remain linked to named evidence, and the current inventory count cannot drift from the current-state record in the operations document.",
    levels: ["unit"],
  },
  {
    id: "G2-3",
    implementation: [{ file: "scripts/check-host-contract.mjs", symbol: "auditHostContract" }, { file: "scripts/check-host-contract.mjs", symbol: "parseDeclarations" }],
    tests: [{ file: "scripts/test/check-host-contract.test.mjs", id: "a host without a test for a shared case fails" }, { file: "scripts/test/check-host-contract.test.mjs", id: "a declared test that did not run, failed, or was skipped does not cover its case" }],
    expected: "Both hosts' tests declare the host contract cases they execute, and the check fails when a host has no passing executed test for a case in its scope.",
    levels: ["unit", "native"],
  },
  {
    id: "G3-1",
    implementation: [
      { file: "scripts/check-test-parity.mjs", symbol: "auditInventory" },
      { file: "scripts/check-test-parity.mjs", symbol: "auditFeatureLinks" },
      { file: "scripts/language-test-adapters.mjs", symbol: "runLanguageCases" },
      { file: "scripts/test-evidence.mjs", symbol: "evidenceDrift" },
    ],
    tests: [
      { file: "scripts/test/test-parity.test.mjs", id: "boundary audit rejects a duplicate implementation and test owner" },
      { file: "scripts/test/test-parity.test.mjs", id: "evidence audit rejects attribution to the wrong behavior-test file" },
      { file: "scripts/test/test-parity.test.mjs", id: "behavior mutation audit rejects a no-op implementation and an omitted response" },
      { file: "scripts/test/test-language-test-adapters.test.mjs", id: "parses each language result and rejects zero, skipped, and crashed outcomes" },
      { file: "scripts/test/test-evidence.test.mjs", id: "evidence records content hashes, dirty state, expected/actual result, and retry history" },
    ],
    expected: "The audit rejects injected structural and behavioral defects, mandatory skips, wrong evidence attribution, and stale executable evidence while reporting structural and behavior evidence separately.",
    levels: ["unit"],
  },
  {
    id: "G3",
    implementation: [
      { file: "scripts/check-test-parity.mjs", symbol: "auditInventory" },
      { file: "scripts/check-hosts.mjs", symbol: "auditHostPairs" },
      { file: "scripts/language-test-adapters.mjs", symbol: "runLanguageCases" },
      { file: "scripts/test-evidence.mjs", symbol: "evidenceDrift" },
    ],
    tests: [
      { file: "scripts/test/test-parity.test.mjs", id: "inventory reports uncovered implementations and tests as separate results" },
      { file: "scripts/test/test-language-test-adapters.test.mjs", id: "parses each language result and rejects zero, skipped, and crashed outcomes" },
      { file: "scripts/test/test-evidence.test.mjs", id: "evidence records content hashes, dirty state, expected/actual result, and retry history" },
      { file: "scripts/test/soksak-scripts.test.mjs", id: "host structure audit rejects a missing host and a missing counterpart" },
    ],
    expected: "Structural and behavioral audits reject missing implementation or test files, excluded or skipped execution, invalid evidence links, stale evidence, and missing host counterparts; no-op effects and responses fail their behavior assertions.",
    levels: ["unit"],
  },
  {
    id: "G1.3-5",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditCommittedEvidenceWording" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "F0.1 evidence identifies its build by its checklist ID" }],
    expected: "F0.1 evidence identifies the build used for its host result by its checklist ID and does not claim that the current worktree is dirty.",
    levels: ["unit"],
  },
  {
    id: "G1.4-1",
    implementation: [
      { file: "scripts/check-test-parity.mjs", symbol: "auditOwnership" },
      { file: "packages/workbench/host.js", symbol: "takes no argument; it uses the declared sidecar" },
      { file: "packages/workbench/environment.js", symbol: "sidecars: surface.sidecars" },
    ],
    tests: [
      { file: "scripts/test/test-parity.test.mjs", id: "ownership audit rejects cross-owner implementation names and private paths" },
      { file: "packages/workbench/test/surface-runtime.test.mjs", id: "surface sidecar access is resolved from the declared surface and takes no argument" },
    ],
    expected: "Implementation and test sources cannot cross owner boundaries or read private paths; plugin sidecar access is resolved from the declaration and never by a name that the page passes.",
    levels: ["unit"],
  },
  {
    id: "G1.3-4",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditModalParitySnapshotWording" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "modal parity Red is dated and followed by current F10.2 evidence" }],
    expected: "The original Wails modal Red remains as a dated observation and the current F10.2 correction is stated without conflating the two states.",
    levels: ["unit"],
  },
  {
    id: "G1.3-3",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditHistoricalScopeWording" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "completed F3 scope is not reported as currently open" }],
    expected: "Completed F3 records preserve their historical sequence without reporting already-closed controlled-site and restored/new-document checks as currently open.",
    levels: ["unit"],
  },
  {
    id: "G1.3-2",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditRecordedInventoryCounts" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "recorded parity counts cannot drift from the current inventory" }],
    expected: "The current lane, implementation, and test counts recorded in both operations-document translations match current inventory output, a count drift fails explicitly, and completed checklist evidence is not compared.",
    levels: ["unit"],
  },
  {
    id: "G1.3-1",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditCompletedFeatureLinks" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "completed capability entries all have feature evidence links" }],
    expected: "Every completed capability checklist entry has a linked implementation, named behavior test, expected result, and verification level, while aggregate review records are explicitly excluded.",
    levels: ["unit"],
  },
  
  {
    id: "F2.12",
    implementation: [
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "service_process_exists" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_transport_replaces_endpoint_left_by_a_dead_service" },
    ],
    expected: "Application-process loss reconnects to a surviving service, while service failure remains an explicit failure or declared replacement and never becomes a new shell.",
    levels: ["native", "application"],
  },
  {
    id: "F2.14",
    implementation: [
      { file: "packages/workbench/host.js", symbol: "onSurfacePrepared" },
      { file: "packages/workbench/surface-modules.js", symbol: "authorizeSurface" },
    ],
    tests: [
      { file: "packages/workbench/test/surface-presentation.test.mjs", id: "native preparation cannot present before DOM drawing and presents each ticket once" },
      { file: "e2e/terminal.test.mjs", id: "newly split terminal presents its first native raster" },
      { file: "e2e/terminal.test.mjs", id: "four split terminals complete native presentation without a host crash" },
      { file: "e2e/terminal.test.mjs", id: "endpoint split requests survive repeated native WebView presentation" },
    ],
    expected: "Prepared native surfaces authorize their modules after host creation, including late registration replay, and rebuilt Tauri/Wails split-terminal checks reach a presented raster without an authorization or presentation timeout.",
    levels: ["unit", "application"],
  },
  
  {
    id: "F0.5.6",
    implementation: [
      { file: "packages/host/tauriv2/src/bindings.rs", symbol: "project_open" },
      { file: "packages/host/tauriv2/src/bindings.rs", symbol: "window_new" },
      { file: "packages/host/tauriv2/src/host.rs", symbol: "on_menu_event" },
    ],
    tests: [
      { file: "e2e/library.test.mjs", id: "library windows create and open projects in place" },
      { file: "e2e/activation/terminal-keyboard.test.mjs", id: "native keyboard edits and executes independently in three terminals" },
      { file: "e2e/normal-shutdown.mjs", id: "normal-shutdown" },
    ],
    expected: "AppKit window creation and activation run on the event-loop thread, the bounded Tauri basic-operation matrix remains observable, and normal shutdown removes the owned endpoint and lock.",
    levels: ["native", "application"],
  },
  {
    id: "F0.5.8",
    implementation: [{ file: "packages/host/tauriv2/src/surfaces.rs", symbol: "sync" }],
    tests: [{ file: "e2e/terminal.test.mjs", id: "four split terminals complete native presentation without a host crash" }],
    expected: "Split-surface synchronization reads the AppKit scale factor on the main thread; a rebuilt Tauri host presents four split terminals without a foreign-exception crash.",
    levels: ["native", "application"],
  },
  {
    id: "F0.5.9",
    implementation: [
      { file: "packages/host/tauriv2/src/exposure.rs", symbol: "root_view_on_main" },
      { file: "packages/host/tauriv2/src/windows.rs", symbol: "with_native_owner" },
      { file: "packages/host/tauriv2/src/surfaces.rs", symbol: "sync" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "endpoint split requests survive repeated native WebView presentation" },
      { file: "e2e/terminal.test.mjs", id: "four split terminals complete native presentation without a host crash" },
      { file: "e2e/normal-shutdown.mjs", id: "normal-shutdown" },
    ],
    expected: "Endpoint and asynchronous split-path WebView and native window-handle lookups run through the AppKit main-thread executor; repeated split requests preserve native presentation and process survival on rebuilt Tauri.",
    levels: ["native", "application"],
  },
  {
    id: "F0.5.9-2",
    implementation: [{ file: "packages/host/tauriv2/src/windows.rs", symbol: "reload_surface_documents" }],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "four split terminals complete native presentation without a host crash" },
      { file: "e2e/terminal.test.mjs", id: "endpoint split requests survive repeated native WebView presentation" },
    ],
    expected: "Main-document reload cleanup finishes before replacement surface images attach; repeated split tests do not leave a new image generation loading after old native image teardown.",
    levels: ["native", "application"],
  },
  {
    id: "F0.5.9-3",
    implementation: [{ file: "packages/window-check/app.mjs", symbol: "acquireWindowCheckSlot" }],
    tests: [
      { file: "e2e/app-contract.test.mjs", id: "window checks reject overlapping sessions that target the same application" },
      { file: "e2e/terminal.test.mjs", id: "newly split terminal presents its first native raster" },
      { file: "e2e/terminal.test.mjs", id: "four split terminals complete native presentation without a host crash" },
      { file: "e2e/terminal.test.mjs", id: "endpoint split requests survive repeated native WebView presentation" },
      { file: "e2e/terminal.test.mjs", id: "native presentation failure is explicit and the next split remains usable" },
    ],
    expected: "Same-application window checks cannot concurrently reset one app's native image generations; rebuilt Tauri and Wails split presentation cases pass with bounded output and no raster timeout.",
    levels: ["unit", "application"],
  },
  {
    id: "F0.5.9-4",
    implementation: [{ file: "packages/host/wailsv3/src/windows.go", symbol: "reloadSurfaceDocuments" }],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "newly split terminal presents its first native raster" },
      { file: "e2e/terminal.test.mjs", id: "four split terminals complete native presentation without a host crash" },
      { file: "e2e/terminal.test.mjs", id: "endpoint split requests survive repeated native WebView presentation" },
      { file: "e2e/terminal.test.mjs", id: "native presentation failure is explicit and the next split remains usable" },
      { file: "e2e/terminal.test.mjs", id: "three terminals and two browsers share one app DOM and one terminal service" },
      { file: "e2e/terminal.test.mjs", id: "closing terminal tabs reaps every PTY child without killing the shared service" },
    ],
    expected: "The Wails stale-page runtime response race is closed at WebViewDidCommitNavigation; the isolated sequential cases pass and the preserved application log contains no stopped runtime response.",
    levels: ["native", "application"],
  },
  {
    id: "F0.5.9-5",
    implementation: [{ file: "packages/host/wailsv3/src/windows.go", symbol: "reloadSurfaceDocuments" }],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "newly split terminal presents its first native raster" },
      { file: "e2e/terminal.test.mjs", id: "four split terminals complete native presentation without a host crash" },
      { file: "e2e/terminal.test.mjs", id: "endpoint split requests survive repeated native WebView presentation" },
      { file: "e2e/terminal.test.mjs", id: "native presentation failure is explicit and the next split remains usable" },
      { file: "e2e/terminal.test.mjs", id: "three terminals and two browsers share one app DOM and one terminal service" },
      { file: "e2e/terminal.test.mjs", id: "closing terminal tabs reaps every PTY child without killing the shared service" },
    ],
    expected: "Wails main-document reload cleanup finishes before replacement surface images attach; the sequential split and cleanup cases pass without a raster presentation timeout.",
    levels: ["native", "application"],
  },
  {
    id: "F4",
    implementation: [
      { file: "native/darwin/src/window_facts.m", symbol: "focused" },
      { file: "packages/host/tauriv2/src/exposure.rs", symbol: "documents" },
      { file: "packages/host/wailsv3/src/exposure.go", symbol: "WindowDocument" },
    ],
    tests: [
      { file: "native/darwin/tests/window_facts_test.m", id: "document webview focus is reported" },
      { file: "e2e/browser.test.mjs", id: "browser document focus and isolation" },
    ],
    expected: "A single click inside a browser document makes that document the native first responder, and a later click in another document transfers focus without leaving the first document focused.",
    levels: ["native", "application"],
  },
  {
    id: "F0.5.7-1",
    implementation: [
      { file: "packages/workbench/page-layout.js", symbol: "waitSurfaceCompositionDeclared" },
      { file: "packages/workbench/surface-modules.js", symbol: "waitSurfaceCompositionDeclared" },
      { file: "packages/plugin-api/surface-composition.js", symbol: "boundaryToken" },
    ],
    tests: [
      { file: "packages/workbench/test/surface-modules.test.mjs", id: "surface mount readiness separates module mount from native presentation" },
      { file: "e2e/projects.test.mjs", id: "project windows persist files, inherit settings, and isolate native state" },
      { file: "e2e/normal-shutdown.mjs", id: "normal-shutdown" },
    ],
    expected: "Command settling waits for module mount and composition declaration without waiting on native presentation, so surface startup cannot form a presentation cycle; project-window and normal-shutdown evidence must pass independently.",
    levels: ["unit", "application"],
  },
  {
    id: "R1",
    implementation: [
      { file: "packages/sok/tauriv2/src/plugins.rs", symbol: "pub fn read_plugins_state" },
      { file: "packages/sok/wailsv3/src/plugins.go", symbol: "func ReadPluginsState" },
      { file: "packages/workbench/plugin-operations.js", symbol: "async function installStarter" },
    ],
    tests: [
      { file: "packages/sok/tauriv2/tests/plugins_test.rs", id: "plugins_state_reports_the_registry_and_the_installation" },
      { file: "packages/sok/wailsv3/tests/plugins_test.go", id: "TestPluginsStateReportsTheRegistryAndTheInstallation" },
      { file: "packages/workbench/test/plugin-operations.test.mjs", id: "the first run installs the starter pack in its order and asks for a reload" },
    ],
    expected: "A registry index lists plugins, sidecars and the starter pack; the installer library of both command lines reports the registry, the index, the installation and the first run, installs selected versions with their sidecars, and the workbench installs the starter pack on the first run before it builds a space.",
    levels: ["unit", "application"],
  },
  {
    id: "F0.5",
    implementation: [
      { file: "packages/workbench/core-exposure.js", symbol: "installCoreExposure" },
      { file: "packages/workbench/surface-modules.js", symbol: "mountSurface" },
    ],
    tests: [
      { file: "e2e/commands.test.mjs", id: "card, tab, and menu commands change the grid" },
      { file: "e2e/modal.test.mjs", id: "settings blocks background input and closes only through its close button" },
      { file: "e2e/browser.test.mjs", id: "browser documents follow host theme pixels for existing, new, and reloaded documents" },
      { file: "e2e/activation/terminal-keyboard.test.mjs", id: "native keyboard edits and executes independently in three terminals" },
      { file: "e2e/library.test.mjs", id: "library windows create and open projects in place" },
      { file: "e2e/normal-shutdown.mjs", id: "normal-shutdown" },
    ],
    expected: "The rebuilt Tauri application starts, accepts prompt and native input, exposes working controls and scoped surfaces, completes first-run project opening, rejects a second owner, prevents undeclared surface placement, and removes its endpoint and lock on normal shutdown.",
    levels: ["unit", "application"],
  },
  {
    id: "F0",
    implementation: [
      { file: "apps/tauriv2/src/main.rs", symbol: "run" },
      { file: "packages/workbench/core-exposure.js", symbol: "installCoreExposure" },
    ],
    tests: [
      { file: "e2e/commands.test.mjs", id: "card, tab, and menu commands change the grid" },
      { file: "e2e/activation/terminal-keyboard.test.mjs", id: "native keyboard edits and executes independently in three terminals" },
      { file: "e2e/browser.test.mjs", id: "browser documents follow host theme pixels for existing, new, and reloaded documents" },
      { file: "e2e/library.test.mjs", id: "library windows create and open projects in place" },
      { file: "e2e/normal-shutdown.mjs", id: "normal-shutdown" },
    ],
    expected: "The rebuilt application starts, performs the existing basic operations through declared commands and native input, and shuts down without leaving its endpoint or owned lock; broader Wails parity and composition/reflow are checked by separate feature entries.",
    levels: ["application"],
  },
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
      { file: "native/darwin/src/webview_input.m", symbol: "webviewInputSendThen" },
    ],
    tests: [
      { file: "native/darwin/tests/input_inject_test.m", id: "a click focuses the field" },
    ],
    expected: "The first native click focuses a terminal and the next character is accepted without a second click.",
    levels: ["unit", "native", "application"],
  },
  {
    id: "F0.1.3",
    implementation: [
      { file: "native/darwin/src/input_inject.m", symbol: "sp_input_key" },
    ],
    tests: [
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
    id: "F0.4",
    implementation: [
      { file: "native/darwin/src/input_inject.m", symbol: "webviewInputSendThen" },
      { file: "native/darwin/src/webview_input.m", symbol: "webviewInputSendThen" },
      { file: "packages/host/wailsv3/src/platform/darwin/input.go", symbol: "pointerSequence" },
    ],
    tests: [
      { file: "native/darwin/tests/input_inject_test.m", id: "a click after keyboard input synthesizes one DOM click" },
      { file: "e2e/sidebar.test.mjs", id: "a combined set mounts every section in list layout and switches sections in tabs layout" },
    ],
    expected: "A native pointer click reaches the DOM control under it on both macOS hosts: a header click folds its section and a tab click shows its section.",
    levels: ["unit", "native", "application"],
  },
  {
    id: "F0.4-1.2",
    implementation: [
      { file: "scripts/check-test-parity.mjs", symbol: "auditJsFailurePropagation" },
      { file: "packages/client/client.js", symbol: "status.unwatch" },
      { file: "packages/workbench/exposure.js", symbol: "release" },
      { file: "packages/workbench/host.js", symbol: "layoutStepEnd" },
      { file: "packages/workbench/projects.js", symbol: "inTurn" },
      { file: "packages/workbench/transcript.js", symbol: "createTranscript" },
    ],
    tests: [
      { file: "scripts/test/test-parity.test.mjs", id: "JS failure audit rejects promise handlers that hide rejection" },
      { file: "packages/workbench/test/transcript.test.mjs", id: "a failed send does not stop later lines" },
    ],
    expected: "Promise rejection handlers in the audited JS/TS implementation cannot silently turn failures into successful completion; visible reporting preserves the failure while allowing independent queued work to proceed.",
    levels: ["unit"],
  },
  {
    id: "F0.4-1.3.1",
    implementation: [
      { file: "scripts/check-test-parity.mjs", symbol: "auditRustFailurePropagation" },
    ],
    tests: [
      { file: "scripts/test/test-parity.test.mjs", id: "Rust failure audit rejects ignored outcomes in the scoped production lane" },
    ],
    expected: "The VT sidecar does not discard production Result or task outcomes; actor, session, monitor, and shutdown failures remain observable through returned errors or explicit reports.",
    levels: ["unit", "native"],
  },
  {
    id: "F0.4-1.3.2",
    implementation: [
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "PersistentConnection" },
      { file: "packages/host/tauriv2/src/recording.rs", symbol: "abort" },
      { file: "packages/host/tauriv2/src/exposure.rs", symbol: "on_main" },
      { file: "scripts/check-test-parity.mjs", symbol: "auditRustFailurePropagation" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_transport_reconnects_after_connection_loss_and_preserves_owner" },
      { file: "packages/host/tauriv2/tests/recording_test.rs", id: "an_aborted_recording_is_stopped_and_removed_and_allows_the_next" },
      { file: "scripts/test/test-parity.test.mjs", id: "Rust failure audit rejects ignored outcomes in the scoped production lane" },
    ],
    expected: "The Tauri host does not discard production Result or callback and cleanup outcomes; transport, delivery, recording, and shutdown failures remain observable through returned errors or explicit reports.",
    levels: ["unit", "native"],
  },
  {
    id: "F0.4-1.3.3",
    implementation: [
      { file: "scripts/check-test-parity.mjs", symbol: "auditRustFailurePropagation" },
      { file: "packages/host/tauriv2/src/platform/windows/unsupported.rs", symbol: "missing" },
    ],
    tests: [
      { file: "scripts/test/test-parity.test.mjs", id: "Rust failure audit covers every production lane" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_transport_rejects_unsupported_hello_protocol_without_replacing_endpoint" },
    ],
    expected: "Every Rust production lane is included in the ignored-outcome audit, and unsupported host operations return explicit errors instead of successful no-op results.",
    levels: ["unit", "native"],
  },
  {
    id: "F0.4-1.4",
    implementation: [
      { file: "native/darwin/src/capture.m", symbol: "sp_capture_error" },
      { file: "packages/host/tauriv2/src/platform/darwin/capture.rs", symbol: "last_error" },
      { file: "scripts/check-test-parity.mjs", symbol: "auditNativeFailurePropagation" },
    ],
    tests: [
      { file: "native/darwin/tests/capture_test.m", id: "open failure is observable to the caller" },
      { file: "scripts/test/test-parity.test.mjs", id: "Darwin native failure audit rejects log-only capture boundaries" },
    ],
    expected: "Darwin capture open, start, wait, and stop failures cross the native boundary as explicit errors; invalid directory input and frame-write failures are not silently discarded.",
    levels: ["unit", "native"],
  },
  {
    id: "F0.4-1.5",
    implementation: [
      { file: "scripts/check-test-parity.mjs", symbol: "auditFailureMatrix" },
      { file: "packages/host/wailsv3/src/recording.go", symbol: "func (r *Recording) Abort" },
    ],
    tests: [
      { file: "scripts/test/test-parity.test.mjs", id: "Go failure audit rejects ignored results in every Go production lane" },
      { file: "packages/host/wailsv3/tests/recording_test.go", id: "TestAbortReportsStopFailureAndStillRemovesFolder" },
    ],
    expected: "The JS/TS, Rust, Go, and Objective-C failure lanes run as one machine-audited matrix; each lane rejects ignored outcomes, and Wails capture, recording cleanup, and shell close failures remain attributable.",
    levels: ["unit", "native"],
  },  {
    id: "F0.4-1-1",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: 'Emit("sidecar-failure"' },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "fn fail<O: Owner>" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestOversizeSidecarMessageTerminatesAndNotifies" },
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestSidecarOutputCloseNotifiesEachSurface" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "an_oversize_message_terminates_and_notifies" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "an_output_close_notifies_each_surface" },
    ],
    expected: "An oversize, invalid or unreadable sidecar output, or an output end outside stop, terminates the sidecar process and delivers sidecar-failure to each owning window on both hosts.",
    levels: ["native"],
  },  {
    id: "F0.4-1-1-1",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "addressed := process.surfaces[event.Surface]" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "unknown surface {}" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestClosedSurfaceMessagesAreDiscardedAndUnknownOnesFail" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "closed_surface_messages_are_discarded_and_unknown_ones_fail" },
    ],
    expected: "A stdio sidecar message for a surface the host closed is discarded, and a message for a surface the host never sent to that process fails the sidecar with unknown surface on both hosts.",
    levels: ["native"],
  },  {
    id: "F0.4-1-1-2",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "func (c *Sidecars) readPersistentLines(" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "fn reply_of(" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentTransportFailsTheConnectionOnAnInvalidEvent" },
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentTransportFailsTheConnectionOnAnOversizeLine" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_transport_fails_the_connection_on_an_invalid_event" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_transport_fails_the_connection_on_an_oversize_line" },
    ],
    expected: "Both hosts read the persistent service connection with the 64 MiB message limit and end it with sidecar-failure to each surface that has sent on an oversize or invalid line, without reconnecting at once.",
    levels: ["native"],
  },  {
    id: "F0.4-1-1-3",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "const sidecarMessageLimit = 64 << 20" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "const MESSAGE_LIMIT: usize = 64 << 20;" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestSidecarMessageAtTheLimitIsDelivered" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "a_message_at_the_limit_is_delivered" },
    ],
    expected: "A sidecar message at the 64 MiB limit reaches the owning window on both hosts at any load; the tests wait for the event, and the 6-19 s delivery at load average 31-33 is not judged by a timer.",
    levels: ["native"],
  },  {
    id: "F0.4-1-1-4",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "export function auditCompletedFeatureLinks" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "completed capability entries all have feature evidence links" }],
    expected: "Every completed checklist capability, the merged sidecar failure delivery included, has a feature link to its implementation and tests.",
    levels: ["unit"],
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
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "Close" },
    ],
    tests: [{ file: "e2e/terminal-processes.test.mjs", id: "process measurement preserves identities" }],
    expected: "Closing terminal tabs reaps their PTY children while retaining the shared terminal service.",
    levels: ["native", "application"],
  },
  
  
  
  {
    id: "F2.6",
    implementation: [
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "service_process_exists" },
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "NewSidecars" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_transport_replaces_endpoint_left_by_a_dead_service" },
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
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_transport_reports_live_but_unreachable_endpoint_without_replacement" },
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentTransportReportsLiveButUnreachableEndpointWithoutReplacement" },
    ],
    expected: "A live but unreachable endpoint returns an explicit connection error and its endpoint record remains byte-for-byte unchanged.",
    levels: ["native"],
  },
  
  
  
  {
    id: "F2.11",
    implementation: [
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "protocol mismatch" },
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "protocol mismatch" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_transport_rejects_unsupported_hello_protocol_without_replacing_endpoint" },
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
    id: "G2",
    implementation: [
      { file: "scripts/check-e2e-host-parity.mjs", symbol: "auditE2EHostParity" },
      { file: "packages/plugin-api/binder.js", symbol: "parentNode" },
      { file: "packages/plugin-api/surface-composition.js", symbol: "detachAll" },
      { file: "apps/tauriv2/runtime/index.js", symbol: "waitPresented" },
      { file: "apps/wailsv3/runtime/index.js", symbol: "waitPresented" },
    ],
    tests: [
      { file: "scripts/test/e2e-host-parity.test.mjs", id: "every application E2E suite runs the same scenario through both adapters" },
      { file: "packages/plugin-api/test/binder.test.mjs", id: "audit recognizes delegated controls inside a shadow root" },
      { file: "packages/plugin-api/test/surface-composition.test.mjs", id: "disposal waits for an in-flight placement before detaching regions" },
      { file: "apps/tauriv2/test/runtime-contract.test.mjs", id: "Tauri page regions expose operations but only composition places geometry" },
      { file: "apps/wailsv3/test/runtime-contract.test.mjs", id: "Wails page regions expose operations but only composition places geometry" },
    ],
    expected: "The completed adapter-parity parent contract is mechanically represented by its child implementation and scenario links; no child evidence is omitted from the audit.",
    levels: ["unit", "application"],
  },
  {
    id: "G2.4",
    implementation: [
      { file: "packages/host/tauriv2/src/bindings.rs", symbol: "project_open" },
      { file: "packages/host/wailsv3/src/projects.go", symbol: "ProjectOpen" },
      { file: "packages/host/wailsv3/src/platform/darwin/webview.m", symbol: "nativeWindowPrepare" },
    ],
    tests: [
      { file: "e2e/projects.test.mjs", id: "project windows persist files, inherit settings, and isolate native state" },
      { file: "e2e/normal-shutdown.mjs", id: "normal-shutdown" },
    ],
    expected: "An isolated public project/window case reports its first failure and the host remains explicitly stoppable within its case limit.",
    levels: ["application"],
  },
  {
    id: "G2.5",
    implementation: [
      { file: "apps/tauriv2/runtime/index.js", symbol: "waitPresented" },
      { file: "apps/wailsv3/runtime/index.js", symbol: "waitPresented" },
    ],
    tests: [
      { file: "apps/tauriv2/test/runtime-contract.test.mjs", id: "Tauri page regions expose operations but only composition places geometry" },
      { file: "apps/wailsv3/test/runtime-contract.test.mjs", id: "Wails page regions expose operations but only composition places geometry" },
    ],
    expected: "Tauri and Wails runtime adapters return the same displayed-state payload from waitPresented and their contract tests assert that returned value.",
    levels: ["unit"],
  },
  {
    id: "G2.9",
    implementation: [{ file: "packages/plugin-api/surface-composition.js", symbol: "detachAll" }],
    tests: [
      { file: "packages/plugin-api/test/surface-composition.test.mjs", id: "disposal waits for an in-flight placement before detaching regions" },
      { file: "e2e/terminal.test.mjs", id: "a newly split terminal presents its first native raster" },
    ],
    expected: "Closing a surface waits for its in-flight composition placement before detaching native regions; rebuilt Tauri and Wails split-terminal checks pass without composition-declaration errors.",
    levels: ["unit", "application"],
  },
  {
    id: "G2.7",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditRecordedInventoryCounts" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "recorded parity counts cannot drift from the current inventory" }],
    expected: "The parity inventory records the current 56 lanes, 251 implementation files, and 171 test files after adding the mechanical E2E host audit.",
    levels: ["unit"],
  },
  {
    id: "G2.6",
    implementation: [{ file: "scripts/check-e2e-host-parity.mjs", symbol: "auditE2EHostParity" }],
    tests: [{ file: "scripts/test/e2e-host-parity.test.mjs", id: "every application E2E suite runs the same scenario through both adapters" }],
    expected: "Every application E2E suite is mechanically required to iterate both Tauri and Wails adapters, while only explicitly documented host-independent suites may be unit-only.",
    levels: ["unit"],
  },
  {
    id: "G2.3",
    implementation: [{ file: "packages/plugin-api/binder.js", symbol: "parentNode" }],
    tests: [
      { file: "packages/plugin-api/test/binder.test.mjs", id: "audit recognizes delegated controls inside a shadow root" },
      { file: "e2e/audit.test.mjs", id: "every control on every screen runs a declared command and has a dom name" },
    ],
    expected: "Delegated controls inside plugin ShadowRoots are recognized by the runtime audit in both rebuilt hosts.",
    levels: ["unit", "application"],
  },
  {
    id: "F11-1",
    implementation: [
      { file: "packages/workbench/core-exposure.js", symbol: "core.page.audit" },
      { file: "packages/workbench/surface-exposure.js", symbol: "unbound" },
    ],
    tests: [{ file: "e2e/audit.test.mjs", id: "every control on every screen runs a declared command and has a dom name" }],
    expected: "Rebuilt Tauri and Wails audit every visible control on workspace, menus, renames, settings scopes and sections, library forms/search, and the return path; every control has a declared command and DOM name.",
    levels: ["application"],
  },
  {
    id: "F11",
    implementation: [
      { file: "packages/workbench/core-exposure.js", symbol: "core.page.audit" },
      { file: "scripts/language-test-adapters.mjs", symbol: "runLanguageCases" },
    ],
    tests: [
      { file: "e2e/audit.test.mjs", id: "every control on every screen runs a declared command and has a dom name" },
      { file: "scripts/test/test-language-test-adapters.test.mjs", id: "parses each language result and rejects zero, skipped, and crashed outcomes" },
    ],
    expected: "Exposure declarations, runtime binder coverage, and every declared JS/TS, Rust, Go, and Objective-C language lane provide attributable behavior results without hidden skips or fallback success.",
    levels: ["unit", "application"],
  },
  {
    id: "F12",
    implementation: [
      { file: "packages/workbench/text-size.js", symbol: "nextTextSize" },
      { file: "packages/workbench/plane.js", symbol: "changeTextSize" },
      { file: "native/darwin/src/document_view.m", symbol: "sp_document_zoom" },
    ],
    tests: [
      { file: "e2e/text-size.test.mjs", id: "text size commands enlarge the pressed card or the frame and keep the plane in the window" },
      { file: "e2e/terminal.test.mjs", id: "the terminal font follows the pressed card's text size" },
      { file: "e2e/browser.test.mjs", id: "the browser document zoom follows the pressed card's text size" },
    ],
    expected: "Command =, -, and 0 change the text size of the last pressed card or of the frame and every card: DOM content by CSS zoom, terminal cells by font size, and browser documents by page zoom, while the plane stays inside the window.",
    levels: ["unit", "application"],
  },
  {
    id: "F17",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "the service did not print its endpoint within" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "the service did not print its endpoint within" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentStartFailsWhenTheServicePrintsNoEndpoint" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_start_fails_when_the_service_prints_no_endpoint" },
    ],
    expected: "A persistent service that prints no endpoint fails the start after the ready limit, and the host ends it, whenever the service starts.",
    levels: ["unit"],
  },
  {
    id: "F20",
    implementation: [
      { file: "packages/host/wailsv3/src/command_line.go", symbol: "ParseArguments" },
      { file: "packages/host/tauriv2/src/command_line.rs", symbol: "parse_arguments" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/command_line_test.go", id: "TestApplicationArgumentsAreDeclaredOnly" },
      { file: "packages/host/tauriv2/tests/command_line_test.rs", id: "application_arguments_are_declared_only" },
    ],
    expected: "Both applications reject an undeclared argument, a flag without a value and a repeated flag with the same text and status 2.",
    levels: ["unit", "application"],
  },
  {
    id: "F26",
    implementation: [
      { file: "packages/plugin-api/index.js", symbol: "function checkDependencies" },
      { file: "packages/sok/wailsv3/src/install.go", symbol: "func ManifestDependencies" },
      { file: "packages/sok/tauriv2/src/install.rs", symbol: "pub fn manifest_dependencies" },
    ],
    tests: [
      { file: "packages/plugin-api/test/validate.test.mjs", id: "a manifest is rejected for each invalid field" },
      { file: "packages/sok/wailsv3/tests/install_test.go", id: "TestPackageJSONDeclaresVersionCoreRangeAndFilesAndTheManifestDeclaresSidecarRanges" },
      { file: "packages/sok/tauriv2/tests/install_test.rs", id: "package_json_declares_version_core_range_and_files_and_the_manifest_declares_sidecar_ranges" },
    ],
    expected: "A plugin declares its sidecars and their version ranges only as the dependencies of plugin.json, and a package.json with soksak is refused.",
    levels: ["unit"],
  },
  {
    id: "F126",
    implementation: [
      { file: "packages/workbench/page-start-errors.js", symbol: "export function installPageStartErrors" },
      { file: "packages/workbench/page-start-errors-install.js", symbol: "export const pageStart" },
    ],
    tests: [
      { file: "packages/workbench/test/page-start-errors.test.mjs", id: "an error before the first screen is written as a page start error with its file and line" },
      { file: "packages/workbench/test/page-start-errors.test.mjs", id: "the first module of the start document installs the handler" },
      { file: "packages/workbench/test/files-list.test.mjs", id: "every file that the start document and the modules of the page import is listed in package.json files" },
    ],
    expected: "An error that stops the main page from starting is written to the application log as error: page start: <text> @ <file>:<line>, and package.json lists every file that the start document and the page modules import.",
    levels: ["unit"],
  },
  {
    id: "F127",
    implementation: [
      { file: "packages/workbench/observe.js", symbol: "diagnostics.page.request" },
      { file: "packages/host/wailsv3/src/assets.go", symbol: "func MissingAssets" },
      { file: "packages/host/tauriv2/src/assets.rs", symbol: "pub struct ReportingAssets" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/assets_test.go", id: "TestMissingAssetsReportEachPathOnce" },
      { file: "packages/host/tauriv2/tests/assets_test.rs", id: "missing_assets_report_each_path_once" },
    ],
    expected: "A request for a page file that does not exist writes error: page asset: <path>: not found once for the path in both hosts.",
    levels: ["unit"],
  },
  {
    id: "F132",
    implementation: [
      { file: "packages/host/tauriv2/src/assets.rs", symbol: "Step::Start => None" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/assets_test.rs", id: "a_missing_file_is_not_answered_with_the_start_document" },
    ],
    expected: "The Tauri host does not answer a path with a file extension that names no file with the start document.",
    levels: ["unit"],
  },
  {
    id: "F125",
    implementation: [
      { file: "scripts/check-registry-manifests.mjs", symbol: "export async function registryManifestErrors" },
    ],
    tests: [
      { file: "scripts/test/registry-manifests.test.mjs", id: "each plugin version that the new core installs and whose manifest it rejects is reported" },
    ],
    expected: "The core of this checkout reads the published registry index, which holds the versions as release and releases, and reports each plugin version whose manifest it rejects.",
    levels: ["unit"],
  },
  {
    id: "F129",
    implementation: [
      { file: "packages/window-check/app.mjs", symbol: "export async function prepareFixture" },
    ],
    tests: [
      { file: "packages/window-check/test/prepare-fixture-settings.test.mjs", id: "the preparation of a check restores the settings that it changed when the check ends" },
    ],
    expected: "The preparation of a window check restores the settings that it changed, including diagnostics.performance, when the check ends.",
    levels: ["unit"],
  },
  {
    id: "F128",
    implementation: [
      { file: "packages/host/wailsv3/src/page_process.go", symbol: "func PageProcessEnded" },
      { file: "packages/host/tauriv2/src/page_process.rs", symbol: "pub fn page_process_ended" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "pub fn connection_loss_report" },
      { file: "packages/host/tauriv2/src/application_log.rs", symbol: "pub fn install_panic_hook" },
      { file: "native/darwin/src/application_log.m", symbol: "void sp_log_install_fatal_handlers" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/page_process_test.go", id: "TestThePageProcessEndIsAnErrorLine" },
      { file: "packages/host/tauriv2/tests/page_process_test.rs", id: "the_page_process_end_is_an_error_line" },
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentTransportWritesAnErrorLineForALostConnection" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "a_lost_connection_is_reported_as_an_error_line" },
      { file: "packages/host/tauriv2/tests/panic_hook_test.rs", id: "a_panic_writes_an_error_line_to_the_application_log" },
      { file: "packages/host/tauriv2/tests/fatal_signal_test.rs", id: "a_fatal_signal_writes_an_error_line_to_the_application_log" },
    ],
    expected: "The end of a page process, a lost connection to a persistent service, a panic of the Tauri host and a fatal signal each write one error line to the application log.",
    levels: ["unit", "application"],
  },
  {
    id: "F120",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "func (c *Sidecars) processPersistent" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "fn start_persistent" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestTheHelloCarriesTheConfigurationDirectoryAsClient" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "the_hello_carries_the_configuration_directory_as_client" },
    ],
    expected: "The hello that either host sends to a persistent service carries the configuration directory of the application as client.",
    levels: ["unit"],
  },
  {
    id: "F130",
    implementation: [
      { file: "packages/host/wailsv3/src/debug.go", symbol: "func debugPruneStates" },
      { file: "packages/host/tauriv2/src/debug.rs", symbol: "fn prune_states" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/debug_test.go", id: "TestDebugWriteStateKeepsTheNewest20StateFiles" },
      { file: "packages/host/tauriv2/tests/debug_test.rs", id: "debug_write_state_keeps_the_newest_20_state_files" },
    ],
    expected: "The host keeps the newest 20 state files of logs/ after it writes one.",
    levels: ["unit"],
  },
  {
    id: "F122",
    implementation: [
      { file: "packages/workbench/projects.js", symbol: "async function closeWindow" },
      { file: "packages/workbench/projects.js", symbol: "async function answerRemoval" },
      { file: "packages/workbench/core-exposure.js", symbol: "registry.command(\"core.space.close\"" },
      { file: "packages/host/wailsv3/src/quit.go", symbol: "type Quit struct" },
      { file: "packages/host/tauriv2/src/quit.rs", symbol: "pub struct Quit" },
      { file: "packages/host/wailsv3/src/project_removal.go", symbol: "type Removals struct" },
      { file: "packages/host/tauriv2/src/project_removal.rs", symbol: "pub struct Removals" },
    ],
    tests: [
      { file: "packages/workbench/test/projects-close-window.test.mjs", id: "a window close request asks about modified tabs before it saves and closes" },
      { file: "packages/workbench/test/projects-close-window.test.mjs", id: "a kept modified tab keeps the window open and unsaved" },
      { file: "packages/workbench/test/projects-close-window.test.mjs", id: "removing the project shown in the window asks about modified tabs before it removes the project" },
      { file: "packages/workbench/test/projects-close-window.test.mjs", id: "removing a project that another window shows asks that window and keeps the project when it refuses" },
      { file: "packages/workbench/test/space-close-asks.test.mjs", id: "core.space.close asks about modified tabs before it removes the active space" },
      { file: "packages/host/wailsv3/tests/quit_test.go", id: "TestACancelledQuitEndsTheQuitState" },
      { file: "packages/host/tauriv2/tests/quit_test.rs", id: "a_cancelled_quit_ends_the_quit_state" },
      { file: "packages/host/wailsv3/tests/project_removal_test.go", id: "TestAProjectRemovalRequestResolvesWithTheOwnerAnswer" },
      { file: "packages/host/tauriv2/tests/project_removal_test.rs", id: "a_project_removal_request_resolves_with_the_owner_answer" },
    ],
    expected: "A window close, a quit, the removal of the active space and the removal of a project ask for each modified tab, and a kept tab keeps the window, the space or the project and ends the quit.",
    levels: ["unit"],
  },
  {
    id: "F133",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "func (c *Sidecars) closeOwnerAndShutdown" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "fn send_close_owner_and_shutdown" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestAStopLeavesTheCloseOfAReplacementToTheReplacement" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "stop_does_not_close_the_owner_again_while_a_replacement_closes_it" },
    ],
    expected: "The close of the owner of a persistent service runs once for its connection, whether a replacement or a stop begins it.",
    levels: ["unit"],
  },
  {
    id: "F117",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "func (c *Sidecars) Replace" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "pub fn replace" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestAnOutdatedServiceIsReplaced" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "an_outdated_service_is_replaced" },
    ],
    expected: "A persistent service that runs another version than the installed one is replaced after its sessions end.",
    levels: ["unit"],
  },
  {
    id: "F121",
    implementation: [
      { file: "packages/sok/wailsv3/src/appupdate.go", symbol: "func ReplaceApp" },
      { file: "packages/sok/tauriv2/src/appupdate.rs", symbol: "pub fn replace_app" },
      { file: "packages/host/wailsv3/src/app_update.go", symbol: "func PrepareAppUpdateStart" },
      { file: "packages/host/tauriv2/src/app_update.rs", symbol: "pub fn prepare_start" },
      { file: "packages/workbench/app-update.js", symbol: "export function createAppUpdate" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/appupdate_test.go", id: "TestTheBundleIsReplacedAfterTheProcessEndedAndTheApplicationStarts" },
      { file: "packages/sok/tauriv2/tests/appupdate_test.rs", id: "the_bundle_is_replaced_after_the_process_ended_and_the_application_starts" },
      { file: "packages/host/wailsv3/tests/app_update_test.go", id: "TestTheUpdateStartsSokFromACopyBesideTheUpdatesAndChecksTheStagedBundle" },
      { file: "packages/host/tauriv2/tests/app_update_test.rs", id: "the_update_starts_sok_from_a_copy_beside_the_updates_and_checks_the_staged_bundle" },
      { file: "packages/workbench/test/app-update.test.mjs", id: "updating stages the candidate, then applies the staged bundle, and reports each step" },
    ],
    expected: "The application stages the release of a newer core, replaces its bundle after it quits and starts again.",
    levels: ["unit"],
  },
  {
    id: "F121.8",
    implementation: [
      { file: "scripts/check-app-update.mjs", symbol: "export function withCore" },
    ],
    tests: [
      { file: "scripts/test/check-app-update.test.mjs", id: "the index lists one newer core release for the key and keeps the rest" },
    ],
    expected: "The application update check lists a core release of a newer version for the host and key of the built bundle.",
    levels: ["unit"],
  },
  {
    id: "F138",
    implementation: [
      { file: "packages/host/wailsv3/src/application_log.go", symbol: "func PageEntry" },
      { file: "packages/host/tauriv2/src/application_log.rs", symbol: "pub fn page_entry" },
      { file: "packages/window-check/application-log.mjs", symbol: "export function parseRecord" },
      { file: "native/darwin/src/application_log.m", symbol: "void sp_log_info" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/application_log_test.go", id: "TestAPageRecordHasTheLayerPageAndRejectsAnInvalidLevelOrPlace" },
      { file: "packages/host/tauriv2/tests/application_log_test.rs", id: "a_page_record_has_the_layer_page_and_rejects_an_invalid_level_or_place" },
      { file: "packages/window-check/test/application-log.test.mjs", id: "parseRecord splits a text record into its time, level, layer, place and text" },
      { file: "packages/workbench/test/report-record.test.mjs", id: "a line `<where>: <text>` is split at its first `: `" },
    ],
    expected: "Every text line of the application log is one record of the form `<time> <level> <layer> <where>: <text>`, and the window check reads that form.",
    levels: ["unit"],
  },
  {
    id: "F148",
    implementation: [
      { file: "scripts/check-versions.mjs", symbol: "export const RELEASE" },
    ],
    tests: [
      { file: "scripts/test/versions.test.mjs", id: "every declared workspace version is the release version" },
    ],
    expected: "Every declared workspace version is the version of the release that carries the records of the application log.",
    levels: ["unit"],
  },
  {
    id: "F145.7",
    implementation: [
      { file: "packages/plugin-api/document-errors.js", symbol: "export function installDocumentErrors" },
      { file: "packages/plugin-api/page.js", symbol: "installDocumentErrors({" },
    ],
    tests: [
      { file: "packages/plugin-api/test/document-errors.test.mjs", id: "a script error, a resource that does not load and an unhandled rejection are reported once each" },
    ],
    expected: "The errors and unhandled rejections of the document of a surface are written to the application log.",
    levels: ["unit"],
  },
  {
    id: "F145.6",
    implementation: [
      { file: "packages/plugin-api/sidecar-port.js", symbol: "export function orderedSidecar" },
      { file: "apps/wailsv3/runtime/index.js", symbol: "report: async (record)" },
      { file: "apps/tauriv2/runtime/index.js", symbol: "report: async (record)" },
    ],
    tests: [
      { file: "packages/plugin-api/test/sidecar-port.test.mjs", id: "a failed send is passed to the failure handler with its error" },
      { file: "apps/wailsv3/test/runtime-contract.test.mjs", id: "Wails page regions expose operations but only composition places geometry" },
      { file: "apps/tauriv2/test/runtime-contract.test.mjs", id: "Tauri page regions expose operations but only composition places geometry" },
    ],
    expected: "A failed send of a page to a sidecar is written to the application log through the report call of the page runtime.",
    levels: ["unit"],
  },
  {
    id: "F145.5",
    implementation: [
      { file: "packages/workbench/core-exposure.js", symbol: "drop: received" },
    ],
    tests: [
      { file: "packages/workbench/test/file-drop-records.test.mjs", id: "a failed file drop is reported with its reason and every drop is logged" },
    ],
    expected: "The page records each file drop and the reason that a drop fails.",
    levels: ["unit"],
  },
  {
    id: "F145.4",
    implementation: [
      { file: "native/darwin/src/input_inject.m", symbol: "static void logPointer" },
    ],
    tests: [
      { file: "native/darwin/tests/input_inject_test.m", id: "a rejected key is recorded with its reason" },
    ],
    expected: "The native library records each injected pointer and key input with its arguments, its result and the reason of a refusal.",
    levels: ["unit"],
  },
  {
    id: "F145.3",
    implementation: [
      { file: "native/darwin/src/webview_input.m", symbol: "logReceiptTimeout" },
    ],
    tests: [
      { file: "native/darwin/tests/webview_input_receipts_test.m", id: "a timed-out wait is recorded with its type and limit" },
    ],
    expected: "The native library records why a wait for a webview input receipt ends.",
    levels: ["unit"],
  },
  {
    id: "F145.2",
    implementation: [
      { file: "native/darwin/src/image_region.m", symbol: "input report dropped" },
    ],
    tests: [
      { file: "native/darwin/tests/image_region_test.m", id: "TEST 8: a noop: command is recorded as dropped" },
    ],
    expected: "The native library records an input that a region drops with its reason.",
    levels: ["unit"],
  },
  {
    id: "F145.1",
    implementation: [
      { file: "packages/host/wailsv3/src/endpoint.go", symbol: "connection closed: " },
      { file: "packages/host/tauriv2/src/endpoint.rs", symbol: "connection closed: {reason}" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/endpoint_test.go", id: "TestEndpointRecordsWhyAConnectionCloses" },
      { file: "packages/host/tauriv2/tests/endpoint_test.rs", id: "the_endpoint_records_why_a_connection_closes" },
    ],
    expected: "A connection of the endpoint that closes writes the reason of the close as an info record before the socket closes.",
    levels: ["unit"],
  },
  {
    id: "F146",
    implementation: [
      { file: "packages/workbench/debug-ui.js", symbol: "debug scroll position is not a number" },
    ],
    tests: [
      { file: "packages/workbench/test/debug-scroll.test.mjs", id: "a negative scroll position of the native modal is kept as reported and a value that is not a number is refused" },
    ],
    expected: "The debug view keeps a negative scroll position that the native modal reports and refuses a value that is not a number.",
    levels: ["unit"],
  },
  {
    id: "F137",
    implementation: [
      { file: "packages/sok/tauriv2/src/appupdate.rs", symbol: "pub type OpenApplication" },
      { file: "packages/sok/wailsv3/tests/appupdate_test.go", symbol: "func requireBundles" },
      { file: "packages/sok/tauriv2/tests/appupdate_test.rs", symbol: "fn bundles_supported" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/appupdate_test.go", id: "TestTheBundleIsReplacedAfterTheProcessEndedAndTheApplicationStarts" },
      { file: "packages/sok/tauriv2/tests/appupdate_test.rs", id: "the_bundle_is_replaced_after_the_process_ended_and_the_application_starts" },
    ],
    expected: "The Rust sok passes clippy, and the tests that stage and replace an application bundle end at once on a platform that does not implement those operations.",
    levels: ["unit"],
  },
  {
    id: "F29",
    implementation: [
      { file: "scripts/check-build-environment.sh", symbol: "pnpm_actual=$(pnpm --version" },
    ],
    tests: [
      { file: "scripts/test/check-build-environment.sh", id: "a standalone pnpm executable of the declared version is accepted" },
    ],
    expected: "The build environment check accepts a pnpm executable of the declared version wherever it is installed and rejects another version.",
    levels: ["unit"],
  },
  {
    id: "F30",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "is not keeping up" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "is not keeping up" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestSlowSidecarDoesNotBlockOtherSends" },
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestStopForcedKill" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "slow_sidecar_does_not_block_other_sends" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "stop_forced_kill" },
    ],
    expected: "A sidecar that does not read its input fills its channel and is killed after the stop deadline on any machine.",
    levels: ["unit"],
  },
  {
    id: "F31",
    implementation: [
      { file: "packages/window-check/application-log.mjs", symbol: "export function readErrors" },
      { file: "packages/workbench/report-record.js", symbol: "export function recordOf" },
    ],
    tests: [
      { file: "packages/window-check/test/session-cleanup.test.mjs", id: "an error line that the application logged during the check fails the check unless it is declared" },
      { file: "packages/workbench/test/report-levels.test.mjs", id: "a reported failure has the level error and an observation has the level info" },
    ],
    expected: "Every error line that the application logs during a window check is printed and fails the check unless the check declares it.",
    levels: ["unit", "application"],
  },
  {
    id: "F34",
    implementation: [
      { file: "packages/workbench/verify.js", symbol: "presentedCardRect(card.id)" },
    ],
    tests: [
      { file: "packages/workbench/test/verify-rail-lines.test.mjs", id: "rail lines are not measured while the plane shows a layout of an earlier size" },
    ],
    expected: "The page verification measures the rail lines only when the plane shows the size of its painted cards.",
    levels: ["unit"],
  },
  {
    id: "F33",
    implementation: [
      { file: "packages/workbench/plane.js", symbol: "transactionSeats?.get(card.id)?.presentation" },
      { file: "packages/workbench/verify.js", symbol: "bands ${" },
    ],
    tests: [
      { file: "packages/workbench/test/verify-ahead.test.mjs", id: "a failed V7c names the surface and both of its rectangles" },
      { file: "e2e/card-panels.test.mjs", id: "a click opens a side folded for lack of space and a drag opens a folded side under the pointer" },
    ],
    expected: "A layout transaction draws the card sidebars with the presentation it predicted the native surface seats with.",
    levels: ["unit", "application"],
  },
  {
    id: "F36",
    implementation: [
      { file: "packages/workbench/app.css", symbol: "round(nearest,calc(var(--chrome-row-h) * var(--frame-text)),1px)" },
    ],
    tests: [
      { file: "e2e/text-size.test.mjs", id: "text size commands enlarge the pressed card or the frame and keep the plane in the window" },
      { file: "packages/workbench/test/verify-ahead.test.mjs", id: "a failed V7b names the surface and its declared and applied rectangles" },
    ],
    expected: "The plane stays on the device pixel grid at every frame text factor, so native surfaces are seated where they are declared.",
    levels: ["unit", "application"],
  },
  {
    id: "F38",
    implementation: [
      { file: "packages/workbench/text-size.js", symbol: "export function effectiveTextScope" },
    ],
    tests: [
      { file: "packages/workbench/test/text-size.test.mjs", id: "without a pressed place the scope is the focused card, and the frame when no card is focused" },
    ],
    expected: "A window without a focused card has the frame as its text size scope.",
    levels: ["unit"],
  },
  {
    id: "F42",
    implementation: [
      { file: "packages/workbench/shown-errors.js", symbol: "export function showError" },
    ],
    tests: [
      { file: "packages/workbench/test/shown-errors.test.mjs", id: "an error shown on the screen is logged once until it changes or clears" },
      { file: "packages/workbench/test/error-display.test.mjs", id: "the error color is used only by the elements of the error display path" },
    ],
    expected: "Every error that the page shows is written to the application log when it appears.",
    levels: ["unit", "application"],
  },
  {
    id: "F32",
    implementation: [
      { file: "packages/plugin-api/surface-composition.js", symbol: "observeFrame = view.requestAnimationFrame" },
    ],
    tests: [
      { file: "packages/plugin-api/test/surface-composition.test.mjs", id: "the controller starts observing at the next animation frame, before that frame's observation round" },
    ],
    expected: "A surface composition controller starts observing at an animation frame, so its first observations are delivered in one round.",
    levels: ["unit", "application"],
  },
  {
    id: "F44",
    implementation: [
      { file: "packages/workbench/projects.js", symbol: "await listener.retain(new Set(remaining.map((item) => item.surface)))" },
    ],
    tests: [
      { file: "packages/workbench/test/projects-switch.test.mjs", id: "the surfaces of every layout are listed with their project root, and removing a project retains the rest" },
      { file: "e2e/library.test.mjs", id: "the library names a missing project folder and removes the project" },
    ],
    expected: "Removing a project disposes the surface modules of its tabs before it ends their sidecar sessions.",
    levels: ["unit", "application"],
  },
  {
    id: "F39",
    implementation: [
      { file: "packages/plugin-api/document-region.js", symbol: "export function observeRegionInsets(element, view, onPlace, report)" },
      { file: "packages/plugin-api/image-region.js", symbol: "no handlers for event type" },
    ],
    tests: [
      { file: "packages/plugin-api/test/document-region.test.mjs", id: "a placement that fails while observing is reported as an error" },
      { file: "packages/plugin-api/test/image-region.test.mjs", id: "an event of a type without handlers is reported as an error, not dropped" },
    ],
    expected: "Region failures that no caller receives are reported as errors, and region observation starts at an animation frame.",
    levels: ["unit"],
  },
  {
    id: "F40",
    implementation: [
      { file: "packages/workbench/host.js", symbol: "data-native-paint-clip" },
    ],
    tests: [
      { file: "packages/workbench/test/overlay-paint-clip.test.mjs", id: "the dialog document receives the page styles without the native paint clip" },
    ],
    expected: "The dialog document receives the page styles without the native paint clip of the main document.",
    levels: ["unit", "application"],
  },
  {
    id: "F37",
    implementation: [
      { file: "packages/host/wailsv3/src/exposure.go", symbol: "ButtonHeldMessage" },
      { file: "packages/host/tauriv2/src/exposure.rs", symbol: "button_held_message" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/endpoint_test.go", id: "TestButtonHeldMessage" },
      { file: "packages/host/tauriv2/tests/exposure_test.rs", id: "button_held_message_reports_mask_and_frontmost_application" },
    ],
    expected: "A 1007 refusal names the held button mask and the frontmost application in the same text on both hosts.",
    levels: ["unit", "application"],
  },
  {
    id: "F35",
    implementation: [
      { file: "native/darwin/src/window_controls.m", symbol: "windowSetTitlebarHeight" },
      { file: "packages/workbench/frame-text.js", symbol: "chromeRow" },
    ],
    tests: [
      { file: "e2e/titlebar-recording.test.mjs", id: "every recorded frame keeps the window buttons centred in the first row while the frame factor steps from 1 to 3 and back" },
    ],
    expected: "The window buttons stay centred in the first row at every frame text factor.",
    levels: ["unit", "application"],
  },
  {
    id: "F35.1",
    implementation: [
      { file: "native/darwin/src/surface_layout.m", symbol: "surfaceLayoutStartPage" },
      { file: "packages/workbench/frame-text.js", symbol: "frameLayout" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/window_titlebar_test.go", id: "TestStartTitlebarFollowsFrameFactor" },
      { file: "packages/host/tauriv2/tests/window_titlebar_test.rs", id: "the_start_titlebar_follows_the_frame_factor" },
      { file: "e2e/titlebar-recording.test.mjs", id: "every recorded frame of a reload after another window changed the frame factor keeps the window buttons centred" },
    ],
    expected: "The title bar height is presented in the layout transaction of the frame that draws the first row, at start, on a reload and at every factor step.",
    levels: ["unit", "application"],
  },
  {
    id: "F35.2",
    implementation: [
      { file: "e2e/titlebar-measurement.mjs", symbol: "measureTitlebar" },
    ],
    tests: [
      { file: "e2e/test/titlebar-measurement.test.mjs", id: "buttons 6px off the first-row centre fail the frame" },
    ],
    expected: "A recording fails on any frame whose button centre and first-row centre differ by more than 0.5px.",
    levels: ["unit"],
  },
  {
    id: "F47",
    implementation: [
      { file: "packages/host/wailsv3/src/application_log.go", symbol: "ErrorLine" },
      { file: "packages/host/tauriv2/src/application_log.rs", symbol: "error_line" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/application_log_test.go", id: "TestLogErrorWritesAnErrorLineToTheApplicationLog" },
      { file: "packages/host/tauriv2/tests/application_log_test.rs", id: "log_error_writes_an_error_line_to_the_application_log" },
    ],
    expected: "Every host failure is written to the application log as an error line that window checks read.",
    levels: ["unit", "application"],
  },
  {
    id: "F48",
    implementation: [
      { file: "packages/host/tauriv2/src/windows.rs", symbol: "list_entries" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/exposure_test.rs", id: "a_close_during_the_list_does_not_fail_the_list" },
    ],
    expected: "The Tauri window list reads each window's closing state and queries it in one main-thread step.",
    levels: ["unit", "application"],
  },
  {
    id: "F49",
    implementation: [
      { file: "packages/workbench/projects.js", symbol: "readProjects" },
    ],
    tests: [
      { file: "packages/workbench/test/projects-switch.test.mjs", id: "a project removed from the registry by another window ends in the window that shows it as closing its tab does" },
      { file: "e2e/library.test.mjs", id: "the library names a missing project folder and removes the project" },
    ],
    expected: "Removing a project ends it in every window that shows it as closing its tab does.",
    levels: ["unit", "application"],
  },
  {
    id: "F50",
    implementation: [
      { file: "packages/workbench/layout-queue.js", symbol: "async wait()" },
    ],
    tests: [
      { file: "packages/workbench/test/tab-close-settled.test.mjs", id: "core.tab.close answers after the tab close and its draw" },
      { file: "packages/workbench/test/layout-queue.test.mjs", id: "the wait for the drawn layout answers false when the newest layout failed" },
    ],
    expected: "A command answers after its handler's work and the newest draw.",
    levels: ["unit", "application"],
  },
  {
    id: "F51",
    implementation: [
      { file: "packages/host/tauriv2/src/windows.rs", symbol: "with_native_owner" },
      { file: "packages/host/wailsv3/src/windows.go", symbol: "UseNativeWindow" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/window_close_test.rs", id: "a_close_after_the_handle_read_does_not_reach_native_code" },
      { file: "packages/host/wailsv3/tests/window_close_test.go", id: "TestACloseBeforeTheNativeStepDoesNotReachNativeCode" },
    ],
    expected: "A native window handle is used only in the main-thread step that reads it.",
    levels: ["unit", "application"],
  },
  {
    id: "F56",
    implementation: [
      { file: "packages/host/tauriv2/src/images.rs", symbol: "wait_current" },
      { file: "packages/host/wailsv3/src/images.go", symbol: "WaitCurrentError" },
      { file: "packages/workbench/host.js", symbol: "layoutStepEnd" },
      { file: "packages/workbench/layout-queue.js", symbol: "async wait()" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/images_test.rs", id: "presentation_wait_timeout_returns_its_failure_and_writes_no_log_line" },
      { file: "packages/host/wailsv3/tests/images_test.go", id: "TestPresentationWaitTimeoutReturnsItsFailureAndWritesNoLogLine" },
      { file: "packages/workbench/test/presentation-failure-lines.test.mjs", id: "one presentation timeout writes one page error line" },
    ],
    expected: "One image presentation timeout writes one application log line, the page display line, on both hosts.",
    levels: ["unit", "application"],
  },
  {
    id: "F52",
    implementation: [
      { file: "Makefile", symbol: "windows-build-check:" },
      { file: "packages/host/wailsv3/src/platform/darwin/endpoint.go", symbol: "err != syscall.EPERM" },
      { file: "packages/host/tauriv2/src/platform/darwin/endpoint.rs", symbol: "Some(EPERM) => {}" },
    ],
    tests: [
      { file: "scripts/test/windows-build-check.test.mjs", id: "the Windows build check compiles the Go host source in the default and diagnostics builds" },
      { file: "scripts/test/windows-build-check.test.mjs", id: "hosts-check runs the Windows build check" },
      { file: "packages/host/wailsv3/tests/service_process_test.go", id: "TestAServiceProcessOfAnotherUserExists" },
      { file: "packages/host/tauriv2/tests/service_process_test.rs", id: "a_service_process_of_another_user_exists" },
    ],
    expected: "Both hosts compile for Windows in the checks, every unsupported Windows operation returns its error, and a service pid of another user exists.",
    levels: ["unit"],
  },
  {
    id: "F53",
    implementation: [
      { file: "packages/host/wailsv3/src/platform/darwin/endpoint.go", symbol: "func (implementation) NewSession" },
      { file: "packages/host/tauriv2/src/platform/darwin/endpoint.rs", symbol: "pub fn new_session" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentServiceStartsInANewSession" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_service_starts_in_a_new_session" },
    ],
    expected: "Both hosts start a persistent service as the leader of a new session.",
    levels: ["unit"],
  },
  {
    id: "F59",
    implementation: [
      { file: "packages/host/wailsv3/src/platform/darwin/private_files.go", symbol: "func (implementation) CreatePrivateFile" },
      { file: "packages/host/wailsv3/src/platform/windows/unsupported.go", symbol: "unsupported(\"private directory creation\")" },
      { file: "packages/host/tauriv2/src/platform/darwin/private_files.rs", symbol: "pub fn create_private_file" },
      { file: "packages/host/tauriv2/src/endpoint.rs", symbol: "platform.create_private_file(&path)" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/private_files_test.go", id: "TestCreatePrivateDirectoriesMakesMissingDirectoriesOwnerOnly" },
      { file: "packages/host/wailsv3/tests/private_files_test.go", id: "TestAppendPrivateFileCreatesAnOwnerOnlyFileAndAppends" },
      { file: "packages/host/wailsv3/tests/private_files_test.go", id: "TestCreatePrivateFileCreatesANewOwnerOnlyFileOnly" },
      { file: "packages/host/wailsv3/tests/endpoint_test.go", id: "TestProcessLockIsOwnerOnly" },
      { file: "packages/host/tauriv2/tests/private_files_test.rs", id: "create_private_directories_makes_missing_directories_owner_only" },
      { file: "packages/host/tauriv2/tests/private_files_test.rs", id: "append_private_file_creates_an_owner_only_file_and_appends" },
      { file: "packages/host/tauriv2/tests/private_files_test.rs", id: "create_private_file_creates_a_new_owner_only_file_only" },
      { file: "packages/host/tauriv2/tests/endpoint_test.rs", id: "the_process_lock_is_owner_only" },
      { file: "packages/host/wailsv3/tests/private_files_test.go", id: "TestWritePrivateFileCreatesAnOwnerOnlyFileAndReplacesItsContents" },
      { file: "packages/host/wailsv3/tests/performance_test.go", id: "TestEnableCreatesOwnerOnlyFiles" },
      { file: "packages/host/wailsv3/tests/webkit_children_test.go", id: "TestTheWebKitChildRecordIsOwnerOnly" },
      { file: "packages/host/tauriv2/tests/private_files_test.rs", id: "write_private_file_creates_an_owner_only_file_and_replaces_its_contents" },
      { file: "packages/host/tauriv2/tests/performance_test.rs", id: "enable_creates_owner_only_files" },
      { file: "packages/host/tauriv2/tests/webkit_children_test.rs", id: "the_webkit_child_record_is_owner_only" },
      { file: "scripts/test/windows-build-check.test.mjs", id: "the Windows build check compiles the Go host source in the default and diagnostics builds" },
    ],
    expected: "Both hosts create owner-only files and directories only through the platform operations, Darwin gives them modes 0700 and 0600, the process lock, the performance files and the WebKit child record have mode 0600 in both hosts, and the Windows implementation compiles and returns its not-implemented errors.",
    levels: ["unit"],
  },
  {
    id: "F63",
    implementation: [{ file: "scripts/test-command.mjs", symbol: "function groupMembers" }],
    tests: [
      { file: "scripts/test/test-command.test.mjs", id: "counts a process group that holds only zombies as gone after a denied probe" },
      { file: "scripts/test/test-command.test.mjs", id: "reads the members of a group from the real process table after a denied probe" },
      { file: "scripts/test/test-command.test.mjs", id: "does not convert denied cleanup verification after SIGKILL into success" },
    ],
    expected: "A refused cleanup probe is decided from the process table: a group with no running member is cleaned, and a running member keeps the EPERM failure.",
    levels: ["unit"],
  },
  {
    id: "F58",
    implementation: [
      { file: "packages/workbench/page-layout.js", symbol: "export function createPageLayout" },
      { file: "packages/workbench/index.html", symbol: "createPageLayout" },
    ],
    tests: [
      { file: "packages/workbench/test/presentation-failure-lines.test.mjs", id: "one presentation timeout writes one page error line" },
      { file: "packages/workbench/test/layout-failure-lines.test.mjs", id: "a layout failure of a project switch started from the interface writes one page error line" },
      { file: "packages/workbench/test/layout-failure-lines.test.mjs", id: "a layout failure that no command waits for writes one page error line" },
    ],
    expected: "The layout wiring of the main page is one module that the page and its tests import.",
    levels: ["unit"],
  },
  {
    id: "F41",
    implementation: [
      { file: "packages/workbench/surface-reply-hold.js", symbol: "createSurfaceReplyHold" },
    ],
    tests: [
      { file: "e2e/late-reply.test.mjs", id: "a surface reply that arrives after its surface closed is discarded as an observation" },
      { file: "e2e/test/late-reply.test.mjs", id: "the observation of a late reply is found only for the closed surface" },
    ],
    expected: "A surface reply that arrives after its surface closed is discarded with an observation and no error line on both hosts.",
    levels: ["unit", "application"],
  },
  {
    id: "F57",
    implementation: [
      { file: "packages/workbench/layout-queue.js", symbol: "item.resolve({ status: \"failed\" })" },
    ],
    tests: [
      { file: "packages/workbench/test/layout-failure-lines.test.mjs", id: "a layout failure of a project switch started from the interface writes one page error line" },
      { file: "packages/workbench/test/layout-failure-lines.test.mjs", id: "a layout failure that no command waits for writes one page error line" },
    ],
    expected: "A layout failure writes one page error line whether a command, a project switch or a gesture started the layout.",
    levels: ["unit", "application"],
  },
  {
    id: "F60",
    implementation: [
      { file: "packages/workbench/surface-modules.js", symbol: "async function disposeModule" },
    ],
    tests: [
      { file: "packages/workbench/test/surface-dispose-order.test.mjs", id: "removing a surface detaches its regions before the module ends its sidecar session" },
    ],
    expected: "Removing a surface detaches its image regions before its module ends the sidecar session, so no frame reaches a region whose image was released.",
    levels: ["unit", "application"],
  },
  {
    id: "F61",
    implementation: [
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "fn close_answer" },
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "func (c *Sidecars) closeAnswered" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "closing terminal tabs reaps every PTY child without killing the shared service" },
    ],
    expected: "A terminal close answers only after the terminal service has reaped the PTY child, on both hosts.",
    levels: ["application"],
  },
  {
    id: "F65",
    implementation: [
      { file: "packages/workbench/plane.js", symbol: "drawSideToggles" },
    ],
    tests: [
      { file: "packages/workbench/test/plane-side-toggles.test.mjs", id: "a draw keeps the pressed card header fold control in the document" },
      { file: "e2e/card-panels.test.mjs", id: "the card header has a fold control for each sidebar the card shows" },
    ],
    expected: "A redraw keeps the card header fold controls in the document, so a click that a draw interrupts still reaches its control.",
    levels: ["unit", "application"],
  },
  {
    id: "F66.1",
    implementation: [
      { file: "packages/workbench/library.js", symbol: "function place(parent, nodes)" },
    ],
    tests: [
      { file: "packages/workbench/test/library-redraw.test.mjs", id: "a library render keeps the controls of unchanged project cards in the document" },
      { file: "packages/workbench/test/library-redraw.test.mjs", id: "a plugin page render keeps the controls of unchanged plugin cards in the document" },
    ],
    expected: "A library render keeps the cards and controls whose values did not change in the document.",
    levels: ["unit"],
  },
  {
    id: "F66.2",
    implementation: [
      { file: "packages/workbench/overlay-content.js", symbol: "export function updateContent" },
      { file: "packages/workbench/overlay.html", symbol: "updateContent(root, html)" },
    ],
    tests: [
      { file: "packages/workbench/test/overlay-content.test.mjs", id: "an update keeps the controls of the dialog in the document and applies the changed values" },
      { file: "packages/workbench/test/overlay-content.test.mjs", id: "an update replaces an element whose kind or command changed" },
    ],
    expected: "A dialog content update keeps unchanged controls in the document and applies only the changes.",
    levels: ["unit"],
  },
  {
    id: "F66",
    implementation: [
      { file: "packages/workbench/library.js", symbol: "function place(parent, nodes)" },
      { file: "packages/workbench/overlay-content.js", symbol: "export function updateContent" },
    ],
    tests: [
      { file: "packages/workbench/test/library-redraw.test.mjs", id: "a library render keeps the controls of unchanged project cards in the document" },
      { file: "packages/workbench/test/overlay-content.test.mjs", id: "an update keeps the controls of the dialog in the document and applies the changed values" },
    ],
    expected: "No redraw of core takes an unchanged control out of the document.",
    levels: ["unit"],
  },
  {
    id: "F67",
    implementation: [
      { file: "packages/plugin-api/list.js", symbol: "export function drawList" },
    ],
    tests: [
      { file: "packages/plugin-api/test/list.test.mjs", id: "drawList keeps the element of each unchanged key and updates it" },
      { file: "packages/plugin-api/test/list.test.mjs", id: "drawList builds new keys, removes missing keys and moves only elements out of order" },
    ],
    expected: "drawList keeps the element of each key in the document and moves only an element out of order.",
    levels: ["unit"],
  },
  {
    id: "F68",
    implementation: [
      { file: "packages/host/wailsv3/src/webkit_children.go", symbol: "func WriteWebKitRecord" },
      { file: "packages/host/tauriv2/src/webkit_children.rs", symbol: "pub fn write_record" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/webkit_children_test.go", id: "TestConcurrentWebKitRecordWritesAllSucceed" },
      { file: "packages/host/tauriv2/tests/webkit_children_test.rs", id: "concurrent_webkit_record_writes_all_succeed" },
    ],
    expected: "Concurrent WebKit child record writes all succeed on both hosts.",
    levels: ["unit"],
  },
  {
    id: "F43",
    implementation: [
      { file: "packages/workbench/page-layout.js", symbol: "async empty(show)" },
    ],
    tests: [
      { file: "packages/workbench/test/projects-switch.test.mjs", id: "browsing shows the library in the draw that empties the plane, not where a later host reply resolves" },
    ],
    expected: "The switch to the library shows the library screen in the prepared draw that empties the plane, before the observation round.",
    levels: ["unit", "application"],
  },
  {
    id: "F64",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "stopClosing map[string]int" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "struct Stopping" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestStopReadsOutputToItsEnd" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "stop_reads_output_to_its_end" },
    ],
    expected: "A stopping sidecar's output is read to its end on both hosts, so the sidecar completes its writes.",
    levels: ["unit", "application"],
  },
  {
    id: "F72",
    implementation: [
      { file: "e2e/package.json", symbol: "verify:shutdown" },
    ],
    tests: [
      { file: "e2e/normal-shutdown.mjs", id: "normal-shutdown" },
    ],
    expected: "Every standalone window check script has a declared entry point.",
    levels: ["application"],
  },
  {
    id: "F74",
    implementation: [
      { file: "Makefile", symbol: "hosts-check: windows-build-check" },
    ],
    tests: [
      { file: "scripts/test/windows-build-check.test.mjs", id: "hosts-check runs the Windows build check" },
    ],
    expected: "hosts-check vets the Wails host for Windows and needs no Windows C compiler.",
    levels: ["unit"],
  },
  {
    id: "F75",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "func (c *Sidecars) Declare(" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "pub fn declare(" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestDeclaringAddsSidecarsInstalledAfterTheStart" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "declaring_adds_sidecars_installed_after_the_start" },
    ],
    expected: "A plugin that the first run installs starts its sidecars without a restart in both hosts.",
    levels: ["unit", "application"],
  },
  {
    id: "F70",
    implementation: [
      { file: "packages/host/wailsv3/go.mod", symbol: "replace github.com/wailsapp/wails/v3 => github.com/min-median-max/wails/v3" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/application_log_test.go", id: "TestTheTransportReturnsAFailedCallWithoutLoggingIt" },
    ],
    expected: "A failed binding call of the Wails host is written once, by the page.",
    levels: ["unit", "application"],
  },
  {
    id: "F79",
    implementation: [
      { file: "packages/host/wailsv3/src/exposure.go", symbol: "relayExpiredLimit" },
      { file: "packages/host/tauriv2/src/exposure.rs", symbol: "EXPIRED_LIMIT" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/exposure_test.go", id: "TestRelayLateReplyStatesItsDelay" },
      { file: "packages/host/tauriv2/tests/exposure_test.rs", id: "late_reply_states_its_delay" },
    ],
    expected: "Both hosts report a timed-out relayed request and its late reply with the same texts and the delay.",
    levels: ["unit"],
  },
  {
    id: "F80",
    implementation: [
      { file: "packages/soksak/src/balance.ts", symbol: "export function sliceTree" },
      { file: "packages/workbench/core-exposure.js", symbol: "core.layout.balance" },
    ],
    tests: [
      { file: "packages/soksak/test/balance.test.mjs", id: "three cards over four give a third and a quarter each, and the rows halve the height" },
      { file: "e2e/balance.test.mjs", id: "the auto-arrange button gives three over four cards a fair share" },
    ],
    expected: "The card auto-arrange button gives every card a fair share and keeps the arrangement.",
    levels: ["unit", "application"],
  },
  {
    id: "F81",
    implementation: [
      { file: "packages/workbench/plane.js", symbol: "export function openCardTools" },
    ],
    tests: [
      { file: "e2e/card-tools-menu.test.mjs", id: "a narrow card folds its tools into a menu that runs them and keeps its title" },
    ],
    expected: "A narrow card header shows the tab list, the current title and a tool menu that runs the tools.",
    levels: ["application"],
  },
  {
    id: "F85",
    implementation: [
      { file: "packages/workbench/plane.js", symbol: "function beginTabDrag" },
    ],
    tests: [
      { file: "e2e/card-fullscreen.test.mjs", id: "a native click on another tab of a fullscreen card switches the tab and keeps fullscreen" },
    ],
    expected: "A click on a tab of a fullscreen card keeps fullscreen.",
    levels: ["application"],
  },
  {
    id: "F86",
    implementation: [
      { file: "packages/workbench/index.html", symbol: "installEnvironment(environmentFile, installedPlugins);" },
    ],
    tests: [
      { file: "e2e/start-failure.test.mjs", id: "a rejected installed plugin manifest stops the page start with a shown and logged error" },
    ],
    expected: "A rejected installed plugin manifest stops the page start with the error shown and logged.",
    levels: ["application"],
  },
  {
    id: "F87",
    implementation: [
      { file: "packages/plugin-api/index.js", symbol: "installed plugin ${plugin.id} ${plugin.version}" },
    ],
    tests: [
      { file: "packages/plugin-api/test/exposure.test.mjs", id: "a rejected installed manifest names the plugin, its version and package" },
    ],
    expected: "A rejected installed manifest names the plugin, its version and package.",
    levels: ["unit"],
  },
  {
    id: "F84",
    implementation: [
      { file: "packages/workbench/plane.js", symbol: "export function openSpaceApps" },
      { file: "packages/workbench/picker-layer.js", symbol: "export function fillPicker" },
    ],
    tests: [
      { file: "packages/workbench/test/picker-layer.test.mjs", id: "a grouped picker draws headings that take no press and counts only the items" },
      { file: "e2e/space-apps.test.mjs", id: "a fullscreen card lists the apps of the space by card and switches to a picked one" },
    ],
    expected: "A fullscreen card lists the apps of the space by card and moves fullscreen to a picked tab's card.",
    levels: ["unit", "application"],
  },
  {
    id: "F82",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "!errors.Is(err, net.ErrClosed)" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentStopDoesNotLogItsOwnCloseAsAReadError" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_stop_does_not_log_its_own_close_as_a_read_error" },
    ],
    expected: "A stop that closes a persistent service connection writes no read error on either host.",
    levels: ["unit"],
  },
  {
    id: "F83",
    implementation: [
      { file: "packages/window-check/app.mjs", symbol: "export function recordingFolders" },
    ],
    tests: [
      { file: "packages/window-check/test/session-cleanup.test.mjs", id: "a recording folder that the check left fails the check and is removed" },
    ],
    expected: "A window check that leaves a recording folder fails, and the harness removes the folder.",
    levels: ["unit"],
  },
  {
    id: "F88",
    implementation: [
      { file: "native/darwin/src/window_controls.m", symbol: "windowSetTitlebarHeight" },
    ],
    tests: [
      { file: "native/darwin/tests/window_controls_test.m", id: "the buttons are centred within one device pixel" },
    ],
    expected: "AppKit centres the window buttons in a title bar of the requested height within one device pixel at every backing scale.",
    levels: ["native"],
  },
  {
    id: "F89",
    implementation: [
      { file: "packages/workbench/verify.js", symbol: "const pixel = 1 / devicePixelRatio" },
    ],
    tests: [
      { file: "packages/workbench/test/verify-controls.test.mjs", id: "the window buttons count as centred within one device pixel of the first row" },
      { file: "e2e/titlebar-recording.test.mjs", id: "window buttons centred" },
    ],
    expected: "The page judges the window buttons centred in the first row within one device pixel at every scale.",
    levels: ["unit", "application"],
  },
  {
    id: "F91",
    implementation: [
      { file: "packages/workbench/surface-modules.js", symbol: "if (entry.disposed) return false;" },
    ],
    tests: [
      { file: "packages/workbench/test/surface-focus-dispose.test.mjs", id: "a surface removed while its focus waits for presentation takes no focus" },
    ],
    expected: "A surface removed while its focus waits takes no focus, and the disposed module is not asked for focus.",
    levels: ["unit"],
  },
  {
    id: "F90",
    implementation: [
      { file: "packages/soksak/src/dom.ts", symbol: "const step = snapshot.step;" },
    ],
    tests: [
      { file: "packages/soksak/test/dom.test.mjs", id: "a paint writes the rects its commit reported when the ratio changes before it draws" },
      { file: "e2e/resize.test.mjs", id: "maximising and restoring settle with the layout at the window size" },
    ],
    expected: "A layout is written on the pixel grid its commit reported, so the cards stay on the rects the host placed when the ratio changes before the draw.",
    levels: ["unit", "application"],
  },
  {
    id: "F73.1",
    implementation: [
      { file: "packages/window-check/app.mjs", symbol: "async record(params = {})" },
    ],
    tests: [
      { file: "packages/window-check/test/recording.test.mjs", id: "a recording whose stop fails reports that stop's error and sends no second stop" },
      { file: "e2e/window-first-frames.test.mjs", id: "a new window shows its complete first screen from its first frame" },
    ],
    expected: "A window check sends one stop for each recording, keeps that stop's error, and leaves no recording folder.",
    levels: ["unit", "application"],
  },
  {
    id: "F93",
    implementation: [
      { file: "Makefile", symbol: "has no test files built with tags" },
    ],
    tests: [
      { file: "scripts/test/language-repeat.test.mjs", id: "go repeat fails a package whose test files are not built" },
      { file: "scripts/test/language-repeat.test.mjs", id: "rust repeat passes its features to every cargo test" },
    ],
    expected: "The Go and Rust repeat targets run tests behind build tags and features and fail when no test ran.",
    levels: ["unit"],
  },
  {
    id: "F92",
    implementation: [
      { file: "packages/workbench/layout-queue.js", symbol: "export function nextTask" },
    ],
    tests: [
      { file: "packages/workbench/test/layout-queue.test.mjs", id: "a prepared draw runs in the next task, not in the checkpoint that answered its preparation" },
      { file: "e2e/outside.test.mjs", id: "native content, cards, and the sidebar rail stay aligned" },
    ],
    expected: "A prepared layout is drawn in the next task, so a drag shows a new layout every display frame at 60 Hz.",
    levels: ["unit", "application"],
  },
  {
    id: "F94",
    implementation: [
      { file: "e2e/real/terminal.test.mjs", symbol: "async function prepare(t, app, line, { fullscreen = false } = {})" },
    ],
    tests: [
      { file: "e2e/real/terminal.test.mjs", id: "a real wheel over a long history is shown without lag, stalls, or reversal" },
    ],
    expected: "The real wheel check measures a fullscreen terminal wide enough for its history lines.",
    levels: ["application"],
  },
  {
    id: "F96.1",
    implementation: [
      { file: "packages/sok/wailsv3/src/install.go", symbol: "func ParseRange" },
      { file: "packages/sok/tauriv2/src/install.rs", symbol: "pub fn parse_range" },
      { file: "packages/plugin-api/engines-check.js", symbol: "export function enginesErrors" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/install_test.go", id: "TestVersionRangesAcceptExactCaretTildeAndBoundedForms" },
      { file: "packages/sok/tauriv2/tests/install_test.rs", id: "version_ranges_accept_exact_caret_tilde_and_bounded_forms" },
      { file: "packages/plugin-api/test/engines-check.test.mjs", id: "a plugin declares the core release of its plugin API" },
    ],
    expected: "The range * is >=0.0.0 without an upper bound in both installers, and soksak-engines accepts it.",
    levels: ["unit"],
  },
  {
    id: "F103",
    implementation: [
      { file: "packages/workbench/stored-layout.js", symbol: "an earlier form of sidebars" },
      { file: "packages/workbench/settings.js", symbol: "const projectSettingsFile" },
    ],
    tests: [
      { file: "packages/workbench/test/window-sidebar-restoration.test.mjs", id: "a stored layout in an earlier form is refused with what it found" },
      { file: "packages/workbench/test/library-preview.test.mjs", id: "a library preview of a layout in an earlier form names projects.json and what it found" },
      { file: "packages/workbench/test/settings.test.mjs", id: "settings stored in an earlier form are refused with the file that holds them and are not written" },
    ],
    expected: "A stored layout or settings file in an earlier form fails with an error that names its file, and nothing is converted or written.",
    levels: ["unit"],
  },
  {
    id: "F113",
    implementation: [
      { file: "native/darwin/src/document_view.m", symbol: "SPDocumentView" },
    ],
    tests: [
      { file: "native/darwin/tests/document_typing_test.m", id: "the field takes the typed text" },
      { file: "e2e/activation/document-typing.test.mjs", id: "an active key window gives a document region typed text" },
    ],
    expected: "A document region takes typed characters in the field that a native press focuses, in a plain AppKit window and in an active key window of both hosts.",
    levels: ["native", "application"],
  },
  {
    id: "F115",
    implementation: [
      { file: "native/darwin/src/document_view.m", symbol: "SPDocumentView" },
    ],
    tests: [
      { file: "native/darwin/tests/document_press_test.m", id: "the first press reaches the page and the drag selects text" },
    ],
    expected: "The first press on a document region that does not hold the keyboard focus reaches its page, and a drag selects text.",
    levels: ["native"],
  },
  {
    id: "F119",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "func take(counts map[string]int, key string) bool" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "fn take(counts: &mut std::collections::BTreeMap<String, usize>, key: &str) -> bool" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestRepeatedCloseAwaitsEachAnswer" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "repeated_close_awaits_each_answer" },
    ],
    expected: "A surface closed again before the sidecar answered stays closing until each close is answered, and no answer fails the sidecar.",
    levels: ["unit"],
  },
  {
    id: "F118",
    implementation: [
      { file: "packages/window-check/app.mjs", symbol: "step(what)" },
    ],
    tests: [
      { file: "packages/window-check/test/session-steps.test.mjs", id: "a check that its test limit ends names the steps it started" },
    ],
    expected: "A window check writes each request and status wait it starts with its elapsed time, so a check that its test limit ends names the step that ran.",
    levels: ["unit"],
  },
  {
    id: "F116",
    implementation: [
      { file: "packages/workbench/surface-modules.js", symbol: "closed before it created its composition" },
    ],
    tests: [
      { file: "packages/workbench/test/surface-dispose-pending.test.mjs", id: "a surface whose module has not finished mounting is disposed without waiting for the mount" },
    ],
    expected: "Closing a tab removes its surface at once also while its module is mounting, and a mount that ends later disposes its module.",
    levels: ["unit"],
  },
  {
    id: "F105",
    implementation: [
      { file: "scripts/check-release.mjs", symbol: "export function auditMinimum" },
      { file: "scripts/check-release.mjs", symbol: "export function machoMinimum" },
    ],
    tests: [
      { file: "scripts/test/check-release-paths.test.mjs", id: "minimum audit requires the declared minimum in Info.plist and the application, and no newer executable" },
      { file: "scripts/test/check-release-paths.test.mjs", id: "machoMinimum reads the minimum macOS version of an executable" },
    ],
    expected: "make release-check fails unless both bundles declare MACOS_MINIMUM and both application executables are built for it.",
    levels: ["unit"],
  },
  {
    id: "F97",
    implementation: [
      { file: "packages/plugin-api/engines-check.js", symbol: "engines.soksak is ${pkg.engines.soksak}" },
    ],
    tests: [
      { file: "packages/plugin-api/test/engines-check.test.mjs", id: "the command checks the package.json of the given plugin repository" },
    ],
    expected: "soksak-engines prints the range it checked.",
    levels: ["unit"],
  },
  {
    id: "F95",
    implementation: [
      { file: "native/darwin/src/webview_geometry.m", symbol: "[main.window disableCursorRects];" },
    ],
    tests: [
      { file: "e2e/real/terminal.test.mjs", id: "slow pointer movement over terminal text" },
    ],
    expected: "The text pointer stays over terminal text during slow pointer movement on both hosts.",
    levels: ["application"],
  },
  {
    id: "F95.1",
    implementation: [
      { file: "native/darwin/src/webview_geometry.m", symbol: "[main.window disableCursorRects];" },
    ],
    tests: [
      { file: "native/darwin/tests/window_cursor_rects_test.m", id: "the window composition turns cursor rectangles off" },
    ],
    expected: "The window composition keeps cursor rectangles off through window changes.",
    levels: ["native"],
  },
  {
    id: "F46",
    implementation: [
      { file: "packages/window-check/app.mjs", symbol: "async releasePresses()" },
    ],
    tests: [
      { file: "packages/window-check/test/pointer-presses.test.mjs", id: "a refused release keeps the press open until the held button is released" },
    ],
    expected: "A check whose press or release a held button refused leaves no open press for a later check.",
    levels: ["unit"],
  },
  {
    id: "F76",
    implementation: [
      { file: "native/darwin/src/capture.m", symbol: "sp_capture_stop" },
    ],
    tests: [
      { file: "native/darwin/tests/capture_resize_test.m", id: "native capture follows a growing window" },
    ],
    expected: "A recording of a growing window ends with a frame of the grown window at device pixels.",
    levels: ["native"],
  },
  {
    id: "F45",
    implementation: [
      { file: "packages/workbench/shown-errors.js", symbol: "element.dataset.error = where" },
    ],
    tests: [
      { file: "packages/workbench/test/error-display.test.mjs", id: "only the error display path marks an element as an error" },
      { file: "packages/workbench/test/error-display.test.mjs", id: "the error color is used only by the elements of the error display path" },
    ],
    expected: "Every error the page shows goes through one display path that logs it, and only that path's elements take the error color.",
    levels: ["unit"],
  },
  {
    id: "F55",
    implementation: [
      { file: "packages/window-check/frontmost.mjs", symbol: "export function sessionBaseline" },
      { file: "packages/window-check/session.mjs", symbol: "export async function globalSetup" },
    ],
    tests: [
      { file: "packages/window-check/test/frontmost.test.mjs", id: "a session whose frontmost application before the checks is a tested host is refused" },
    ],
    expected: "A window-check run whose frontmost application before the checks is a tested host fails once before its first check.",
    levels: ["unit"],
  },
  {
    id: "F62",
    implementation: [
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", symbol: "func serveHarnessConnections" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "second opens after the first reconnected" },
    ],
    expected: "The Wails persistent transport harness receives a connection event for each host when one host's revived connection reaches the service before the other host's first connection.",
    levels: ["unit"],
  },
  {
    id: "F28",
    implementation: [
      { file: "packages/window-check/pasteboard.mjs", symbol: "pasteboardDifference" },
    ],
    tests: [
      { file: "packages/window-check/test/pasteboard.test.mjs", id: "a changed value names the item, the type and both lengths and digests" },
    ],
    expected: "A pasteboard that differs after a window check is reported by item, type, length and digest.",
    levels: ["unit"],
  },
  {
    id: "F27",
    implementation: [
      { file: "e2e/terminal.test.mjs", symbol: "the notification authorization of this application is not decided" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "an OSC 9 notification from a terminal out of view follows the system policy and then the tab policy" },
    ],
    expected: "The OSC 9 policy check of a bundled application names an undecided authorization and checks that the tab policy posts nothing new.",
    levels: ["application"],
  },
  {
    id: "F24",
    implementation: [
      { file: "e2e/terminal.test.mjs", symbol: "region.presented !== null" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "a presentation that fails while the terminal service is stopped leaves the next fixture and splits usable" },
    ],
    expected: "The window check of a failed terminal presentation waits while a region has not presented yet.",
    levels: ["application"],
  },
  {
    id: "F23",
    implementation: [
      { file: "packages/sok/wailsv3/src/plugins.go", symbol: "file.Chmod(mode)" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/plugins_test.go", id: "TestPluginInstallSetsTheModesWhateverTheUmask" },
      { file: "packages/sok/tauriv2/tests/plugins_test.rs", id: "plugin_install_sets_the_modes_whatever_the_umask" },
    ],
    expected: "Both sok implementations write extracted files at mode 0755 or 0644 under any umask.",
    levels: ["unit"],
  },
  {
    id: "F14",
    implementation: [
      { file: "native/darwin/src/quit_request.m", symbol: "sp_quit_request_install" },
      { file: "packages/host/wailsv3/src/platform/darwin/termination.go", symbol: "OnQuitRequest" },
      { file: "packages/host/tauriv2/src/platform/darwin/termination.rs", symbol: "on_quit_request" },
    ],
    tests: [
      { file: "native/darwin/tests/quit_request_test.m", id: "the quit event does not reach applicationShouldTerminate:" },
    ],
    expected: "The operating system's quit request runs the host's quit and is answered without an error after the saves, in both hosts.",
    levels: ["unit", "application"],
  },
  {
    id: "F21",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "func (c *Sidecars) Stop()" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "pub fn stop(&self)" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentStopAcceptsTheAnswerToACloseSentBeforeTheStop" },
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_stop_accepts_the_answer_to_a_close_sent_before_the_stop" },
    ],
    expected: "A persistent service's answer to a close sent before the stop is accepted, and the stop sends close-owner and then shutdown.",
    levels: ["unit"],
  },
  {
    id: "F22",
    implementation: [
      { file: "packages/window-check/repeat.mjs", symbol: "USAGE" },
    ],
    tests: [
      { file: "packages/window-check/test/repeat.test.mjs", id: "repeat prints the diagnostics of each passing run" },
    ],
    expected: "The repeat tool's tests run the tool under the FORCE_COLOR they set, without an inherited NO_COLOR, so its output holds no node color warning.",
    levels: ["unit"],
  },
  {
    id: "F15",
    implementation: [
      { file: "packages/host/wailsv3/src/endpoint.go", symbol: "invalid process lock" },
      { file: "packages/host/tauriv2/src/endpoint.rs", symbol: "invalid process lock" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/endpoint_test.go", id: "TestEndpointRejectsAMalformedLock" },
      { file: "packages/host/tauriv2/tests/endpoint_test.rs", id: "a_malformed_process_lock_is_refused" },
    ],
    expected: "Both hosts refuse a process.lock whose contents are not a positive process ID with the same text.",
    levels: ["unit"],
  },
  {
    id: "F16",
    implementation: [
      { file: "packages/plugin-api/exposure-check.js", symbol: "realpathSync(process.argv[1])" },
      { file: "packages/plugin-api/engines-check.js", symbol: "realpathSync(process.argv[1])" },
    ],
    tests: [{ file: "packages/plugin-api/test/command-entry.test.mjs", id: "the plugin commands run their check when started through a linked package" }],
    expected: "soksak-exposure and soksak-engines run their check when a plugin repository starts them through the package that its package manager links.",
    levels: ["unit"],
  },
  {
    id: "V1",
    implementation: [{ file: "scripts/checklist.mjs", symbol: "checkCompletedItems" }],
    tests: [{ file: "scripts/test/checklist.test.mjs", id: "checklist permits translated text and linked follow-up identifiers" }],
    expected: "The canonical English and Korean checklist keeps the same identifiers, nesting, and states, preserves completed scope, and records only evidence-backed completion claims.",
    levels: ["unit"],
  },
  {
    id: "V2",
    implementation: [
      { file: "scripts/check-hosts.mjs", symbol: "auditHostPairs" },
      { file: "packages/workbench/host.js", symbol: "waitPresented" },
    ],
    tests: [
      { file: "scripts/test/soksak-scripts.test.mjs", id: "host structure audit reports a clean paired-host graph" },
      { file: "e2e/terminal.test.mjs", id: "a newly split terminal presents its first native raster" },
    ],
    expected: "Audit infrastructure and bounded basic surface presentation are complete for both adapters, while uncovered restoration and IME scopes remain open rather than nominally active.",
    levels: ["unit", "application"],
  },
  {
    id: "V4",
    implementation: [{ file: "e2e/projects.test.mjs", symbol: "two independent project states" }],
    tests: [{ file: "e2e/projects.test.mjs", id: "two independent project states repeat create-use-close-recreate in one instance" }],
    expected: "Rebuilt Tauri and Wails repeat independent project creation, visible-surface use, close, registry removal, and recreation in one application instance without manual state compensation.",
    levels: ["application"],
  },
  
  
  
  
  {
    id: "F9",
    implementation: [{ file: "e2e/library.test.mjs", symbol: "restoration connection" }],
    tests: [{ file: "e2e/library.test.mjs", id: "library windows create and open projects in place" }],
    expected: "Rebuilt Tauri and Wails library returns report connection, document, raster, and first-presentation phases with explicit failure preservation.",
    levels: ["application"],
  },
  {
    id: "F1",
    implementation: [
      { file: "e2e/terminal.test.mjs", symbol: "three terminals survive repeated divider drags and project returns" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "three terminals survive repeated divider drags and project returns" },
      { file: "e2e/terminal.test.mjs", id: "terminal image follows a window resize" },
    ],
    expected: "Current rebuilt Tauri and Wails windows preserve DOM/native containment and shell pixels through divider drags, while terminal resize preserves text, fixed cell metrics, and raster geometry.",
    levels: ["unit", "application"],
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
    id: "G1.3-6",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditRecordedInventoryCounts" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "recorded parity counts cannot drift from the current inventory" }],
    expected: "The inventory record remains synchronized after adding language adapter implementation and test files, while the earlier count remains historical evidence.",
    levels: ["unit"],
  },
  {
    id: "G1.3-7",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditRecordedInventoryCounts" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "recorded parity counts cannot drift from the current inventory" }],
    expected: "The inventory record remains synchronized after adding the evidence recorder and its test.",
    levels: ["unit"],
  },
  {
    id: "G1.3-8",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "auditFeatureLinks" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "completed capability entries all have feature evidence links" }],
    expected: "The feature-link and parity self-test record is synchronized with the current completed entries.",
    levels: ["unit"],
  },
  {
    id: "G4",
    implementation: [{ file: "scripts/language-test-adapters.mjs", symbol: "runLanguageCases" }],
    tests: [{ file: "scripts/test/test-language-test-adapters.test.mjs", id: "reports expected and actual test counts without hiding mismatch" }],
    expected: "Every declared language case is bounded, observable, attributable, and rejects incomplete or mismatched results.",
    levels: ["unit", "native"],
  },
  {
    id: "G4.1",
    implementation: [{ file: "scripts/test-command.mjs", symbol: "runCommand" }],
    tests: [{ file: "scripts/test/test-command.test.mjs", id: "emits ordered start and terminal events" }],
    expected: "Supervised commands emit attributable start/progress/final events, visible output, bounded failure, and cleanup results.",
    levels: ["unit"],
  },
  {
    id: "G4.2",
    implementation: [
      { file: "scripts/language-test-adapters.mjs", symbol: "runLanguageCases" },
      { file: "scripts/language-test-cases.json", symbol: "version" },
    ],
    tests: [
      { file: "scripts/test/test-language-test-adapters.test.mjs", id: "discovers all supported language cases" },
      { file: "scripts/test/test-language-test-manifest.test.mjs", id: "committed language manifest declares one non-empty case" },
    ],
    expected: "Each supported language has an attributable bounded case with expected and actual test counts; zero, skipped, failed, crashed, timed-out, or cancelled execution cannot pass.",
    levels: ["unit", "native"],
  },
  {
    id: "G4.3",
    implementation: [{ file: "scripts/test-evidence.mjs", symbol: "collectEvidence" }],
    tests: [{ file: "scripts/test/test-evidence.test.mjs", id: "evidence records content hashes, dirty state, expected/actual result, and retry history" }],
    expected: "Evidence contains immutable source and process identity snapshots and preserves every retry result.",
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
      { file: "e2e/outside.test.mjs", id: "terminal divider drag does not leave a white surface frame" },
    ],
    expected: "A complete divider recording keeps native content inside its card, keeps card and rail geometry aligned, contains no white surface frame, and returns to its initial position.",
    levels: ["native", "application"],
  },
  {
    id: "F3.3",
    implementation: [
      { file: "packages/host/tauriv2/src/documents.rs", symbol: "set_document_appearance" },
      { file: "packages/host/wailsv3/src/documents.go", symbol: "SetDocumentAppearance" },
    ],
    tests: [{ file: "e2e/browser.test.mjs", id: "browser documents follow host theme pixels for existing, new, and reloaded documents" }],
    expected: "Existing, newly split, and reloaded browser documents apply the current host theme before presentation and retain their explicit HTTP(S) location.",
    levels: ["unit", "native", "application"],
  },
  {
    id: "F3.4",
    implementation: [
      { file: "packages/host/tauriv2/src/theme.rs", symbol: "set" },
      { file: "packages/host/wailsv3/src/theme.go", symbol: "SetTheme" },
    ],
    tests: [{ file: "e2e/browser.test.mjs", id: "a site's appearance remains independent of the host theme" }],
    expected: "A local document that fixes its own colour keeps that colour when the host switches light to dark, the region receives the host color scheme, and its URL remains unchanged.",
    levels: ["application"],
  },
  {
    id: "F3.1",
    implementation: [
      { file: "native/darwin/src/document_view.m", symbol: "sp_document_appearance" },
      { file: "packages/host/tauriv2/src/theme.rs", symbol: "set" },
      { file: "packages/host/wailsv3/src/theme.go", symbol: "SetTheme" },
    ],
    tests: [{ file: "native/darwin/tests/document_view_test.m", id: "the document renderer follows the owner's light appearance change" }],
    expected: "Existing native browser documents follow explicit host dark/light appearance changes on both hosts.",
    levels: ["native", "application"],
  },
  {
    id: "F3.2",
    implementation: [
      { file: "packages/host/tauriv2/src/windows.rs", symbol: "reload_surface_documents" },
      { file: "packages/host/wailsv3/src/windows.go", symbol: "reloadSurfaceDocuments" },
    ],
    tests: [{ file: "packages/host/tauriv2/tests/documents_test.rs", id: "documents_reserve_names_and_close_with_their_surface" }],
    expected: "Restoring a native surface makes its document visible only after the authoritative surface host is ready.",
    levels: ["unit", "native", "application"],
  },
  {
    id: "F1.2",
    implementation: [{ file: "e2e/terminal.test.mjs", symbol: "ensureTerminals" }],
    tests: [{ file: "e2e/terminal.test.mjs", id: "three terminals survive repeated divider drags and project returns" }],
    expected: "Three terminals retain sessions and presented native regions through repeated divider moves and project returns.",
    levels: ["application"],
  },
  {
    id: "F1.3-1",
    implementation: [{ file: "e2e/terminal.test.mjs", symbol: "roundTripsPerSet" }],
    tests: [{ file: "e2e/terminal.test.mjs", id: "three terminals survive repeated divider drags and project returns" }],
    expected: "Rapid divider acceptance preserves complete draw transactions, native containment, text, and the declared return matrix.",
    levels: ["application"],
  },
  {
    id: "G4.1-1",
    implementation: [{ file: "e2e/normal-shutdown.mjs", symbol: "normal-shutdown" }],
    tests: [{ file: "e2e/normal-shutdown.mjs", id: "normal-shutdown" }],
    expected: "Normal shutdown reports bounded process and endpoint disappearance with event-driven progress and no fixed sleep success path.",
    levels: ["application"],
  },
  {
    id: "G1.4",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "implementationOwners" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "inventory reports uncovered implementations and tests as separate results" }],
    expected: "Every discovered implementation and test file has one explicit ownership lane, with duplicate and uncovered ownership rejected.",
    levels: ["unit"],
  },
  {
    id: "F5",
    implementation: [
      { file: "packages/workbench/core-exposure.js", symbol: "registry.command" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "terminal cursor policy uses declared settings, persistence, and pixels" },
      { file: "e2e/terminal.test.mjs", id: "newly split terminal presents its first native raster" },
    ],
    expected: "Both rebuilt macOS hosts persist declared terminal cursor settings, reject invalid updates, render the effective policy in native pixels, and complete the first raster after a split without a presentation timeout.",
    levels: ["unit", "native", "application"],
  },
  {
    id: "F6",
    implementation: [
      { file: "e2e/terminal.test.mjs", symbol: "terminal file drop pastes quoted paths without executing" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "native terminal selection renders and copies through one explicit paste" },
      { file: "e2e/terminal.test.mjs", id: "terminal file drop pastes quoted paths without executing" },
      { file: "e2e/terminal.test.mjs", id: "inline image pixels follow scroll, resize, replacement, deletion, and cleanup" },
    ],
    expected: "The terminal selection, paste, file-drop, and inline-image contracts are implemented and verified through their unit and rebuilt native-host scenarios without input loss or unintended execution.",
    levels: ["unit", "native", "application"],
  },
  {
    id: "F6.4",
    implementation: [
      { file: "packages/host/tauriv2/src/clipboard.rs", symbol: "pub(crate) fn read" },
      { file: "packages/host/wailsv3/src/clipboard.go", symbol: "func (h *Host) ClipboardRead" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "native terminal selection renders and copies through one explicit paste" },
    ],
    expected: "Explicit terminal paste preserves text, inserts validated quoted file paths and owned PNG paths exactly once without a newline or automatic execution, and both native hosts preserve typed absent clipboard responses.",
    levels: ["unit", "native", "application"],
  },
  {
    id: "F6.3-2",
    implementation: [
      { file: "native/darwin/src/surface_layout.m", symbol: "surfaceLayoutAfterSettled" },
      { file: "packages/host/tauriv2/src/exposure.rs", symbol: "pub(crate) fn presented" },
      { file: "packages/host/wailsv3/src/exposure.go", symbol: "func (s *Surfaces) presented" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "newly split terminal presents its first native raster" },
      { file: "e2e/terminal.test.mjs", id: "native presentation failure is explicit and the next split remains usable" },
      { file: "e2e/terminal.test.mjs", id: "three terminals and two browsers share one app DOM and one terminal service" },
    ],
    expected: "A native settle failure is returned as an explicit callback error instead of being converted into a generic 1005 timeout, and fresh Tauri/Wails split regressions remain usable afterward.",
    levels: ["native", "application"],
  },
  {
    id: "F6.3-3",
    implementation: [
      { file: "packages/host/tauriv2/src/surfaces.rs", symbol: "pub(crate) async fn present" },
      { file: "native/darwin/src/surface_layout.m", symbol: "surfaceLayoutCancel" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "native presentation failure is explicit and the next split remains usable" },
    ],
    expected: "A Tauri presentation failure cancels the open native layout transaction and the next split remains usable; the bounded regression reports START/PASS and exits cleanly.",
    levels: ["native", "application"],
  },
  {
    id: "F6.3-8",
    implementation: [
      { file: "packages/host/tauriv2/src/images.rs", symbol: "pub fn handle_envelope_with_recovery" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "fn decide_image_envelope" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/images_test.rs", id: "missing_native_surface_requests_a_fresh_raster_configuration" },
      { file: "packages/host/tauriv2/tests/images_test.rs", id: "frame_detached_before_main_thread_presentation_is_reported_as_stale" },
      { file: "e2e/terminal.test.mjs", id: "newly split terminal presents its first native raster" },
      { file: "e2e/terminal.test.mjs", id: "four split terminals complete native presentation without a host crash" },
      { file: "e2e/terminal.test.mjs", id: "endpoint split requests survive repeated native WebView presentation" },
      { file: "e2e/terminal.test.mjs", id: "native presentation failure is explicit and the next split remains usable" },
    ],
    expected: "A missing IOSurface requests a fresh raster configuration, a detached frame is reported as explicit stale invalidation, and a rebuilt single-process Tauri host passes new, four, repeated, and failure-recovery split cases without a presentation error.",
    levels: ["unit", "application"],
  },
  
  
  {
    id: "F8",
    implementation: [
      { file: "native/darwin/src/image_region.m", symbol: "commitThrough" },
      { file: "native/darwin/src/image_region.m", symbol: "reportPreedit" },
    ],
    tests: [
      { file: "native/darwin/tests/image_region_ime_test.m", id: "image region: Backspace during a composition edits it to 하 without PTY input" },
      { file: "native/darwin/tests/image_region_ime_test.m", id: "image region: Escape during a composition commits it once and is reported after it" },
      { file: "e2e/activation/ime.test.mjs", id: "a Korean syllable typed right after an input-source switch reaches the PTY once" },
      { file: "e2e/activation/marked-text.test.mjs", id: "marked text that the input method ends is written to the PTY once" },
    ],
    expected: "The real macOS Korean input method composes in the terminal region with its preedit shown, edits with Backspace, commits each syllable exactly once before a following key such as Escape or Enter, and never writes uncommitted text to the PTY on both hosts; the AppKit control in the same window produces the same document.",
    levels: ["native", "application"],
  },
  {
    id: "F6.5",
    implementation: [
      { file: "native/darwin/src/webview_geometry.m", symbol: "SPFileDropView" },
      { file: "packages/workbench/core-exposure.js", symbol: "dropFiles" },
    ],
    tests: [
      { file: "packages/plugin-api/test/exposure.test.mjs", id: "a surface drop names a command declared in the manifest's exposes" },
      { file: "e2e/terminal.test.mjs", id: "terminal file drop pastes quoted paths without executing" },
      { file: "e2e/real/terminal.test.mjs", id: "a real Finder drag of a file and of an image pastes their quoted paths without executing" },
    ],
    expected: "A file dropped on a window reaches the native file drop view, which sends path URLs and the drop point; the page runs the drop command that the plugin of the surface under the point declares, and the terminal validates local URLs, shell-quotes all paths, and sends one non-executing paste; unsupported and malformed drops remain explicit errors on both rebuilt hosts.",
    levels: ["unit", "application"],
  },
  
  
  {
    id: "F10",
    implementation: [
      { file: "packages/host/tauriv2/src/modals.rs", symbol: "pub(crate) fn show" },
      { file: "packages/host/wailsv3/src/modals.go", symbol: "OverlayShow" },
      { file: "packages/workbench/compositor.js", symbol: "placementPending" },
    ],
    tests: [
      { file: "e2e/modal.test.mjs", id: "add and split menus are transparent and have no backdrop" },
      { file: "e2e/modal.test.mjs", id: "settings blocks background input and closes only through its close button" },
      { file: "e2e/modal.test.mjs", id: "moving settings and resizing the parent preserves its native coverage" },
    ],
    expected: "Both rebuilt hosts preserve the existing transparent picker and semi-transparent settings modal contract through focus, dismissal, movement, resize, reload, and deferred geometry verification.",
    levels: ["native", "application"],
  },
  {
    id: "F10.1",
    implementation: [{ file: "packages/host/tauriv2/src/modals.rs", symbol: "pub(crate) fn show" }],
    tests: [{ file: "e2e/modal.test.mjs", id: "settings blocks background input and closes only through its close button" }],
    expected: "Tauri picker and settings modals preserve transparent picker paint, semi-transparent settings coverage, input blocking, focus, resize, and cleanup.",
    levels: ["application"],
  },
  {
    id: "F10.2",
    implementation: [{ file: "packages/host/wailsv3/src/modals.go", symbol: "OverlayShow" }],
    tests: [{ file: "e2e/modal.test.mjs", id: "add and split menus are transparent and have no backdrop" }],
    expected: "Wails uses the same hidden transparent child-webview modal contract and reports ready, focus, coverage, resize, and cleanup.",
    levels: ["application"],
  },
  {
    id: "F10.3",
    implementation: [{ file: "packages/host/tauriv2/src/modals.rs", symbol: "pub(crate) fn hide" }],
    tests: [
      { file: "e2e/modal.test.mjs", id: "add and split menus are transparent and have no backdrop" },
      { file: "e2e/modal.test.mjs", id: "settings blocks background input and closes only through its close button" },
    ],
    expected: "A replacement native modal retains child-WebView focus; both rebuilt hosts preserve transparent picker paint, the settings scrim and blur, input blocking, dismissal, focus return, stale ordering, reload, movement, and resize.",
    levels: ["native", "application"],
  },
  {
    id: "F10.4",
    implementation: [
      { file: "packages/host/wailsv3/src/modals.go", symbol: "OverlayShow" },
      { file: "packages/workbench/compositor.js", symbol: "placementPending" },
      { file: "packages/workbench/verify.js", symbol: "placementPending" },
    ],
    tests: [
      { file: "e2e/modal.test.mjs", id: "moving settings and resizing the parent preserves its native coverage" },
      { file: "packages/workbench/test/compositor.test.mjs", id: "a layout published before drawing waits for the host's placement answer" },
    ],
    expected: "The rebuilt Wails host completes the full modal lifecycle and the verifier explicitly defers V7/V10/R geometry decisions until the native placement answer is seated.",
    levels: ["native", "application"],
  },
  {
    id: "V5",
    implementation: [{ file: "packages/soksak/scripts/check-breaks.mjs", symbol: "run" }],
    tests: [{ file: "scripts/test/soksak-scripts.test.mjs", id: "break inventory lists only requested, known entries" }],
    expected: "The break audit runs each test file with a 20-second deadline in isolated parallel copies, reports progress, and catches all 142 declared breaks without an aggregate timeout or silent result.",
    levels: ["unit"],
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

const OWNER_ROOTS = [
  ["packages/", "core"],
  ["plugins/", "plugin"],
  ["sidecars/", "sidecar"],
  ["native/", "native"],
  ["apps/", "application"],
  ["e2e/", "contract"],
];
const DECLARATION_FILE = /(^|\/)(package|plugin|sidecar|environment|exposure)\.json$/;
const PRIVATE_SEGMENT = /(^|\/)(src|tests?|internal|private)(\/|$)/;
const IMPORT_SPECIFIER = /(?:from\s*|import\s*\(|require\s*\(|import\s+)["'`]([^"'`]+)["'`]/g;
const PACKAGE_REFERENCE = /@soksak\/(?:plugin|sidecar)-[a-z0-9-]+(?:\/(?:src|tests?|internal|private)(?:\/[a-z0-9_./-]+)?)?/g;

function ownerFor(file) {
  return OWNER_ROOTS.find(([root]) => file.startsWith(root))?.[1] ?? null;
}

function isDeclaration(file) {
  return DECLARATION_FILE.test(file);
}

function packageOwner(name) {
  const base = name.split("/").slice(0, 2).join("/");
  if (base === "@soksak/plugin-api" || base === "@soksak/runtime" || base === "@soksak/workbench") return "core";
  if (base.startsWith("@soksak/plugin-") && (base.endsWith("-example") || [
    "@soksak/plugin-browser", "@soksak/plugin-files", "@soksak/plugin-shell", "@soksak/plugin-terminal",
  ].includes(base))) return "plugin";
  if (base.startsWith("@soksak/sidecar-") && (base.endsWith("-example") || [
    "@soksak/sidecar-files", "@soksak/sidecar-shell", "@soksak/sidecar-vt-alacritty", "@soksak/sidecar-vt-core",
  ].includes(base))) return "sidecar";
  return null;
}

function ownerReferences(source) {
  const references = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) references.push({ value: match[1], private: PRIVATE_SEGMENT.test(match[1]) });
  for (const match of source.matchAll(PACKAGE_REFERENCE)) {
    if (!references.some(({ value }) => value === match[0])) references.push({ value: match[0], private: PRIVATE_SEGMENT.test(match[0]) });
  }
  return references;
}

/**
 * 소유자 경계를 검사한다. 선언 파일만 플러그인과 사이드카를 연결할 수 있다.
 * 이 함수는 동작 테스트가 아니라 구현·테스트 소스의 금지된 참조를 기계적으로
 * 판정한다. 앱과 e2e는 공개 계약의 소비자이므로 다른 공개 패키지를 사용할 수 있지만
 * private/src/tests 경로는 모든 소유자에서 금지한다.
 */
export function auditOwnership(files, readSource = (file) => readFileSync(`${ROOT}${file}`, "utf8")) {
  const errors = [];
  for (const file of [...new Set(files)].sort()) {
    const owner = ownerFor(file);
    if (!owner || isDeclaration(file)) continue;
    let source;
    try { source = readSource(file); }
    catch (error) {
      errors.push(`${file}: ownership source cannot be read: ${error?.message ?? error}`);
      continue;
    }
    const testFile = /(^|\/)(test|tests|e2e)\//.test(file) || /[._]test\./.test(file);
    for (const reference of ownerReferences(source)) {
      const value = reference.value;
      const pathOwner = OWNER_ROOTS.find(([root]) => value.includes(root))?.[1] ?? null;
      const referencedOwner = pathOwner ?? (value.startsWith("@soksak/") ? packageOwner(value) : null);
      if (reference.private && referencedOwner && referencedOwner !== owner) {
        errors.push(`${file}: ${owner}${testFile ? " test" : " implementation"} reads private path ${value}`);
        continue;
      }
      if (!referencedOwner || referencedOwner === owner || referencedOwner === "core") continue;
      if (owner === "application" || owner === "contract") continue;
      errors.push(`${file}: ${owner}${testFile ? " test" : " implementation"} names ${referencedOwner} implementation ${value}`);
    }
  }
  return errors;
}

/** Reject promise handlers that turn a rejected operation into an unobservable success. */
export function auditJsFailurePropagation(files, readSource = (file) => readFileSync(`${ROOT}${file}`, "utf8")) {
  const errors = [];
  for (const file of [...new Set(files)].sort()) {
    if (!/\.(?:js|mjs|ts|tsx)$/.test(file) || /(^|\/)(test|tests|e2e)\//.test(file)) continue;
    let source;
    try { source = readSource(file); }
    catch (error) {
      errors.push(`${file}: failure-propagation source cannot be read: ${error?.message ?? error}`);
      continue;
    }
    const patterns = [
      { expression: /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g, name: "empty catch handler" },
      { expression: /\.catch\(\s*\(\s*\)\s*=>\s*undefined\s*\)/g, name: "undefined catch handler" },
    ];
    for (const { expression, name } of patterns) {
      for (const match of source.matchAll(expression)) {
        const line = source.slice(0, match.index).split("\n").length;
        errors.push(`${file}:${line}: ${name} hides a rejected operation`);
      }
    }
  }
  return errors;
}

/** Reject explicit Result/JoinHandle discards in the scoped Rust production lane. */
export function auditRustFailurePropagation(files, readSource, scope) {
  const errors = [];
  for (const file of [...new Set(files)].sort()) {
    if (!file.startsWith(scope) || !file.endsWith(".rs") || /(^|\/)(test|tests)\//.test(file)) continue;
    let source;
    try { source = readSource(file); }
    catch (error) {
      errors.push(`${file}: Rust failure-propagation source cannot be read: ${error?.message ?? error}`);
      continue;
    }
    for (const [index, line] of source.split("\n").entries()) {
      if (/\blet\s+_\s*=/.test(line)) {
        errors.push(`${file}:${index + 1}: ignored Rust result or task outcome`);
      }
    }
  }
  return errors;
}

/** Require the Darwin capture FFI to return native failures instead of logging and succeeding. */
export function auditNativeFailurePropagation(files, readSource = (file) => readFileSync(`${ROOT}${file}`, "utf8")) {
  const errors = [];
  const header = "native/darwin/src/capture.h";
  const bridge = "packages/host/tauriv2/src/platform/darwin/capture.rs";
  const implementation = "native/darwin/src/capture.m";
  if (!files.includes(header) || !files.includes(bridge) || !files.includes(implementation)) return errors;
  let headerSource, bridgeSource, implementationSource;
  try {
    headerSource = readSource(header);
    bridgeSource = readSource(bridge);
    implementationSource = readSource(implementation);
  } catch (error) {
    errors.push(`Darwin capture failure audit cannot read its sources: ${error?.message ?? error}`);
    return errors;
  }
  for (const name of ["sp_capture_open", "sp_capture_start"]) {
    const declaration = new RegExp(`\\bvoid\\s+${name}\\s*\\(`);
    if (declaration.test(headerSource) || declaration.test(implementationSource)) {
      errors.push(`${name}: native capture failure cannot be represented by a void return`);
    }
    if (!new RegExp(`fn\\s+${name}\\([^)]*\\)\\s*->\\s*bool`).test(bridgeSource)) {
      errors.push(`${name}: Rust FFI declaration must return bool`);
    }
  }
  if (!/sp_capture_error/.test(headerSource) || !/sp_capture_error/.test(bridgeSource)) {
    errors.push("Darwin capture: native failure text is not exposed across the FFI boundary");
  }
  if (/let\s+Ok\([^)]*\)\s*=\s*CString::new[\s\S]{0,120}\breturn\s*;/.test(bridgeSource)) {
    errors.push("Darwin capture: invalid directory input is silently discarded");
  }
  return errors;
}

/** Reject ignored Go outcomes in host and shell production lanes. */
export function auditGoFailurePropagation(files, readSource = (file) => readFileSync(`${ROOT}${file}`, "utf8")) {
  const errors = [];
  for (const file of [...new Set(files)].sort()) {
    if (!file.endsWith(".go") || /(^|\/)(test|tests)\//.test(file)) continue;
    let source;
    try { source = readSource(file); }
    catch (error) {
      errors.push(`${file}: Go failure-propagation source cannot be read: ${error?.message ?? error}`);
      continue;
    }
    for (const [index, line] of source.split("\n").entries()) {
      if (/\b_\s*=/.test(line)) {
        errors.push(`${file}:${index + 1}: ignored Go result or fallback encoding`);
      }
    }
  }
  return errors;
}

/** Run every language-specific failure audit and preserve attribution by lane. */
export function auditFailureMatrix(files, readSource = (file) => readFileSync(`${ROOT}${file}`, "utf8")) {
  const lanes = [
    ["js-ts", auditJsFailurePropagation(files, readSource)],
    ["rust", [
      "packages/host/tauriv2/src/",
      "packages/sok/tauriv2/src/",
      "apps/tauriv2/src/",
    ].flatMap((scope) => auditRustFailurePropagation(files, readSource, scope))],
    ["go", auditGoFailurePropagation(files, readSource)],
    ["objective-c", auditNativeFailurePropagation(files, readSource)],
  ];
  return {
    lanes: lanes.map(([language, errors]) => ({ language, errors })),
    errors: lanes.flatMap(([language, errors]) => errors.map((error) => `${language}: ${error}`)),
  };
}

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

const nonExecutableLanguages = new Set(["native-interface", "declaration", "document", "stylesheet"]);

export function auditExecutableLanguageCoverage(files, adapterLanguages) {
  const implemented = new Set(discoverInventory(files).implementations
    .map(({ language }) => language)
    .filter((language) => !nonExecutableLanguages.has(language)));
  const covered = new Set(adapterLanguages);
  const errors = [];
  for (const language of [...implemented].sort()) {
    if (!covered.has(language)) errors.push(`executable implementation language ${language} has no language adapter test case`);
  }
  for (const language of [...covered].sort()) {
    if (!implemented.has(language)) errors.push(`language adapter declares ${language} but no executable implementation uses it`);
  }
  return errors;
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

export function auditInventory(files, matrix = MATRIX, readSource = (file) => readFileSync(`${ROOT}${file}`, "utf8")) {
  const matches = new Map();
  const expand = (pattern) => {
    if (!matches.has(pattern)) {
      const regex = globRegex(pattern);
      matches.set(pattern, files.filter((file) => regex.test(file)));
    }
    return matches.get(pattern);
  };
  const unique = (patterns) => [...new Set(patterns.flatMap(expand))].sort();
  const extensionOf = (file) => extname(file) || basename(file);
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
  const ownershipErrors = auditOwnership(files, readSource);
  errors.push(...ownershipErrors);
  const failureMatrix = auditFailureMatrix(files, readSource);
  const jsFailureErrors = failureMatrix.lanes.find(({ language }) => language === "js-ts").errors;
  errors.push(...failureMatrix.errors);
  const rustFailureErrors = failureMatrix.lanes.find(({ language }) => language === "rust").errors;
  const nativeFailureErrors = failureMatrix.lanes.find(({ language }) => language === "objective-c").errors;
  const goFailureErrors = failureMatrix.lanes.find(({ language }) => language === "go").errors;

  return {
    errors,
    warnings,
    inventory,
    uncoveredImplementations,
    uncoveredTests,
    featureErrors,
    ownershipErrors,
    jsFailureErrors,
    rustFailureErrors,
    nativeFailureErrors,
    goFailureErrors,
    failureMatrix,
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

// Aggregate review and release records, withdrawn items and changes of agent guidance (R4, R6) are not capabilities and
// therefore do not need a behavior link. Every completed capability must have one otherwise.
const NON_CAPABILITY_COMPLETIONS = new Set(["F13", "F25", "G1.4-2", "R2", "R4", "R6", "V3", "F96", "F99", "F99.1", "F99.2", "F99.3", "F99.4", "F106", "F108"]);

// Completed capabilities whose implementation and tests are in a plugin or sidecar repository: those that
// moved there (R1-5, docs/spec/plugins.md#repositories) and changes made there (F98, F100, F101, F109) and the window checks of plugins (F110). Core cannot read
// those repositories, so they have no link here and each repository checks its own evidence.
const MOVED_COMPLETIONS = new Set(["F0.3", "F1.4", "F2.1-1", "F2.10", "F2.1", "F2.4-1", "F2.4", "F2.5", "F2.8", "F2.9", "F2", "F3", "F6.3-10", "F6.6-1", "F6.6-2", "F7.14", "F7.15", "F7.16", "F7.17", "F7", "G1.2", "F18", "F19", "F98", "F100", "F101", "F109", "F110"]);

export function auditCompletedFeatureLinks(features, checklistSource = readFileSync(`${ROOT}docs/features.md`, "utf8")) {
  const linked = new Set(features.map((feature) => feature.id));
  const completed = [...checklistSource.matchAll(/^- \[o\] ([A-Z][A-Z0-9.-]*) —/gm)].map((match) => match[1]);
  return completed
    .filter((id) => !NON_CAPABILITY_COMPLETIONS.has(id) && !MOVED_COMPLETIONS.has(id) && !linked.has(id))
    .map((id) => `${id}: completed capability has no feature link`);
}

// 현재 inventory 수는 운영 문서의 현재 상태 문장에 기록한다. 완료된 체크리스트 항목의 증거는 바꾸지 않는다.
export function auditRecordedInventoryCounts(
  inventory,
  english = readFileSync(`${ROOT}docs/operations/examples.md`, "utf8"),
  korean = readFileSync(`${ROOT}docs/operations/examples.ko.md`, "utf8"),
) {
  const expected = [inventory.trackCount, inventory.implementationCount, inventory.testCount].map(String);
  const records = [
    ["docs/operations/examples.md", english, /The current inventory has (\d+) lanes, (\d+) implementation files, and (\d+) test files\./],
    ["docs/operations/examples.ko.md", korean, /현재 목록은 lane (\d+)개, 구현 파일 (\d+)개, 테스트 파일 (\d+)개다\./],
  ];
  const errors = [];
  for (const [path, source, pattern] of records) {
    const match = source.match(pattern);
    if (!match) {
      errors.push(`${path}: the current inventory count is not recorded in the expected form`);
      continue;
    }
    const actual = match.slice(1);
    if (!actual.every((value, index) => value === expected[index])) {
      errors.push(`${path}: recorded parity counts ${actual.join(", ")} do not match current output ${expected.join(", ")}`);
    }
  }
  return errors;
}

export function auditHistoricalScopeWording(checklistSource = readFileSync(`${ROOT}docs/features.md`, "utf8")) {
  const forbidden = [
    "Controlled-site pixel and restored/new-document application checks remain open under F3.",
    "Controlled-site pixels and restored/new-document validation remain open under F3.",
  ];
  return forbidden.filter((phrase) => checklistSource.includes(phrase)).map((phrase) => `F3 scope is reported as currently open: ${phrase}`);
}

export function auditModalParitySnapshotWording(checklistSource = readFileSync(`${ROOT}docs/features.md`, "utf8")) {
  const line = checklistSource.split("\n").find((entry) => entry.includes("At the 2026-09-21 audit snapshot"));
  if (!line) return ["modal parity observation is not explicitly dated as a historical snapshot"];
  if (!line.includes("The later F10.2 correction creates the Wails child-WebView contract")) {
    return ["modal parity observation does not state the current F10.2 correction"];
  }
  return [];
}

export function auditCommittedEvidenceWording(checklistSource = readFileSync(`${ROOT}docs/features.md`, "utf8")) {
  const line = checklistSource.split("\n").find((entry) => entry.includes("F0.1 — Unblock native input measurement"));
  if (!line) return ["F0.1 evidence line is missing"];
  if (line.includes("current dirty implementation")) return ["F0.1 evidence still claims a current dirty implementation"];
  // 기록은 commit id 를 적지 않는다(AGENTS.md Documentation). 증거는 자기 build 를 체크리스트 ID 로 가리킨다.
  if (!line.includes("this F0.1 change")) return ["F0.1 evidence does not identify its build by its checklist ID"];
  return [];
}

export { MATRIX, repositoryFiles };

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { errors, warnings, uncoveredImplementations, uncoveredTests, featureErrors, featureLinks, trackCount, implementationCount, testCount } = auditInventory(repositoryFiles());
  const adapterManifestFile = `${ROOT}scripts/language-test-cases.json`;
  try {
    const adapterManifest = JSON.parse(readFileSync(adapterManifestFile, "utf8"));
    if (!Array.isArray(adapterManifest.cases)) errors.push(`${adapterManifestFile}: cases must be an array`);
    else errors.push(...auditExecutableLanguageCoverage(repositoryFiles(), adapterManifest.cases.map(({ language }) => language)));
  } catch (error) {
    errors.push(`${adapterManifestFile}: cannot read language adapter cases: ${error.message}`);
  }
  errors.push(...auditCompletedFeatureLinks(featureLinks));
  errors.push(...auditRecordedInventoryCounts({ trackCount, implementationCount, testCount }));
  errors.push(...auditHistoricalScopeWording());
  errors.push(...auditModalParitySnapshotWording());
  errors.push(...auditCommittedEvidenceWording());
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
