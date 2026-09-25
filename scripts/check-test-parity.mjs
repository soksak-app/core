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
  lane("host contract audit", "js-ts", ["scripts/check-host-contract.mjs"], ["scripts/test/check-host-contract.test.mjs"]),
lane("command supervision", "js-ts", ["scripts/test-command.mjs"], ["scripts/test/test-command.test.mjs"]),
lane("language test adapters", "js-ts", ["scripts/language-test-adapters.mjs"], ["scripts/test/test-language-test-adapters.test.mjs"]),
lane("language test adapter manifest", "declaration", ["scripts/language-test-cases.json"], ["scripts/test/test-language-test-manifest.test.mjs"], { testLanguage: "js-ts" }),
lane("test evidence", "js-ts", ["scripts/test-evidence.mjs"], ["scripts/test/test-evidence.test.mjs"]),
lane("workspace version audit", "js-ts", ["scripts/check-versions.mjs"], ["scripts/test/versions.test.mjs"]),
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
    "scripts/check-e2e-host-parity.mjs",
    "scripts/check-exposure.mjs",
    "scripts/check-terminal-protocol-inventory.mjs",
    "scripts/sidecar-packages.mjs",
  ], ["scripts/test/soksak-scripts.test.mjs", "scripts/test/e2e-host-parity.test.mjs"], { sharedTests: true }),
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
  lane("Darwin link open", "objective-c", ["native/darwin/src/link.m"], ["native/darwin/tests/link_test.m"], { sharedTests: true }),
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
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "F0.1 evidence identifies its committed build" }],
    expected: "F0.1 evidence identifies the committed build used for its host result and does not claim that the current worktree is dirty.",
    levels: ["unit"],
  },
  {
    id: "G1.4-1",
    implementation: [
      { file: "scripts/check-test-parity.mjs", symbol: "auditOwnership" },
      { file: "packages/workbench/host.js", symbol: "does not accept a package name" },
      { file: "packages/workbench/environment.js", symbol: "sidecars: surface.sidecars" },
    ],
    tests: [
      { file: "scripts/test/test-parity.test.mjs", id: "ownership audit rejects cross-owner implementation names and private paths" },
      { file: "packages/workbench/test/surface-runtime.test.mjs", id: "surface sidecar access is resolved from the declared surface and rejects package names" },
    ],
    expected: "Implementation and test sources cannot cross owner boundaries or read private paths; plugin sidecar access is resolved from the declaration and never by a package-name fallback.",
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
    id: "F2",
    implementation: [{ file: "sidecars/vt-core/src/platform/darwin/service.rs", symbol: "serve_persistent" }],
    tests: [{ file: "e2e/terminal-processes.test.mjs", id: "process measurement preserves identities" }],
    expected: "The shared terminal service, per-session PTYs, normal shutdown, and application-process recovery preserve declared ownership and session identity.",
    levels: ["native", "application"],
  },
  {
    id: "F2.12",
    implementation: [
      { file: "sidecars/vt-core/src/platform/darwin/service.rs", symbol: "serve_persistent" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "service_process_exists" },
    ],
    tests: [
      { file: "scripts/verify-vt-recovery.mjs", id: "application_process_restarted" },
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
    id: "F3",
    implementation: [{ file: "plugins/browser/ui/browser.js", symbol: "mount" }],
    tests: [
      { file: "e2e/browser.test.mjs", id: "browser documents follow host theme pixels for existing, new, and reloaded documents" },
      { file: "e2e/browser.test.mjs", id: "Google site appearance remains independent of host theme" },
    ],
    expected: "Restored and new browser documents follow the host appearance contract while explicit Google site preferences remain isolated from host theme changes.",
    levels: ["native", "application"],
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
      { file: "packages/host/tauriv2/src/windows.rs", symbol: "native_owner_on_main" },
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
    implementation: [{ file: "e2e/app.mjs", symbol: "acquireWindowCheckSlot" }],
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
    expected: "The Wails stale-page runtime response race is closed at WebViewDidCommitNavigation; the isolated sequential cases pass and the preserved app log contains no stopped runtime response.",
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
      { file: "packages/workbench/index.html", symbol: "waitSurfaceCompositionDeclared" },
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
    id: "F0.5",
    implementation: [
      { file: "packages/workbench/core-exposure.js", symbol: "installCoreExposure" },
      { file: "packages/workbench/surface-modules.js", symbol: "mountSurface" },
    ],
    tests: [
      { file: "e2e/commands.test.mjs", id: "card, tab, and menu commands change the grid" },
      { file: "e2e/modal.test.mjs", id: "settings blocks background input and closes only through its close button" },
      { file: "e2e/shell.test.mjs", id: "shell input returns shell output through the shell sidecar" },
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
    id: "F0.4-1.2",
    implementation: [
      { file: "scripts/check-test-parity.mjs", symbol: "auditJsFailurePropagation" },
      { file: "packages/client/client.js", symbol: "status.unwatch" },
      { file: "packages/workbench/exposure.js", symbol: "release" },
      { file: "packages/workbench/host.js", symbol: "continueAfterLayoutFailure" },
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
      { file: "sidecars/vt-core/src/protocol.rs", symbol: "serve_with_options" },
      { file: "sidecars/vt-core/src/platform/pty.rs", symbol: "kill_process_group" },
      { file: "sidecars/vt-core/src/platform/darwin/service.rs", symbol: "serve_with_registry" },
      { file: "scripts/check-test-parity.mjs", symbol: "auditRustFailurePropagation" },
    ],
    tests: [
      { file: "sidecars/vt-core/tests/serve_contract.rs", id: "test_panicking_surface_reports_error" },
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
      { file: "sidecars/shell/src/shell/shells.go", symbol: "func (s *Shells) Close" },
    ],
    tests: [
      { file: "scripts/test/test-parity.test.mjs", id: "Go failure audit rejects ignored results in every Go production lane" },
      { file: "packages/host/wailsv3/tests/recording_test.go", id: "TestAbortReportsStopFailureAndStillRemovesFolder" },
    ],
    expected: "The JS/TS, Rust, Go, and Objective-C failure lanes run as one machine-audited matrix; each lane rejects ignored outcomes, and Wails capture, recording cleanup, and shell close failures remain attributable.",
    levels: ["unit", "native"],
  },
  {
    id: "F2.1-1",
    implementation: [{ file: "sidecars/vt-core/tests/pty_lifecycle.rs", symbol: "lifecycle_test_lock" }],
    tests: [
      { file: "sidecars/vt-core/tests/pty_lifecycle.rs", id: "real_sessions_are_independent_and_close_removes_session" },
      { file: "sidecars/vt-core/tests/pty_lifecycle.rs", id: "three_real_sessions_reconnect_with_same_pid_and_retained_output" },
    ],
    expected: "Real PTY lifecycle cases do not run their macOS process-group cleanup concurrently; the default vt-core package test command passes without changing production PTY behavior.",
    levels: ["native"],
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
      { file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_transport_reconnects_after_connection_loss_and_preserves_owner" },
      { file: "packages/host/wailsv3/tests/sidecars_transport_test.go", id: "TestPersistentTransportHarnessEndpointAuthConcurrentReconnectAndCloseAck" },
    ],
    expected: "A client connection loss reconnects to the persistent service while preserving the owning surface identity.",
    levels: ["native"],
  },
  {
    id: "F2.4-1",
    implementation: [{ file: "sidecars/vt-core/src/platform/darwin/service.rs", symbol: "serve_persistent" }],
    tests: [{ file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "persistent_transport_reconnects_after_connection_loss_and_preserves_owner" }],
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
      { file: "plugins/terminal/ui/terminal.js", symbol: "setTextSize" },
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
    id: "F7.14",
    implementation: [{ file: "sidecars/vt-alacritty/src/engine.rs", symbol: "alternate screen mode {}{}" }],
    tests: [
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "csi_cursor_next_and_previous_line_are_observable" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "alternate_screen_is_separate_from_primary_scrollback" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "unsupported_csi_alternate_modes_are_explicit_errors" },
    ],
    expected: "The CSI inventory distinguishes implemented E/F and 1049 behavior from explicitly rejected 47, 1047, and 1048 modes, with observable cursor/grid or error evidence.",
    levels: ["unit", "native"],
  },
  {
    id: "F7.15",
    implementation: [
      { file: "sidecars/vt-core/src/protocol.rs", symbol: "pub focus_in_out: bool" },
      { file: "sidecars/vt-alacritty/src/engine.rs", symbol: "TermMode::FOCUS_IN_OUT" },
    ],
    tests: [{ file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "csi_private_modes_export_keyboard_paste_and_mouse_state" }],
    expected: "The public terminal mode contract exposes and resets focus, UTF-8 mouse, SGR mouse, alternate-scroll, keyboard, mouse, and bracketed-paste states with mutually exclusive mouse encoding transitions.",
    levels: ["unit", "native"],
  },
  {
    id: "F7.16",
    implementation: [{ file: "sidecars/vt-alacritty/src/engine.rs", symbol: "device_status" }],
    tests: [
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "csi_device_status_reports_are_observable" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "unsupported_csi_window_report_is_an_explicit_error" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "unsupported_csi_rectangle_protected_and_palette_reports_are_explicit_errors" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "csi_fragmentation_and_malformed_input_preserve_engine_state" },
    ],
    expected: "CSI status, device-attribute, text-area, unsupported-window, intermediate, fragmented, and malformed-input paths have named observable response or rejection evidence.",
    levels: ["unit", "native"],
  },
  {
    id: "F7.17",
    implementation: [{ file: "scripts/check-terminal-protocol-inventory.mjs", symbol: "auditTerminalProtocolInventory" }],
    tests: [
      { file: "scripts/test/soksak-scripts.test.mjs", id: "terminal protocol inventory rejects missing, duplicate, or unlinked CSI rows" },
      { file: "scripts/test/soksak-scripts.test.mjs", id: "terminal protocol inventory reproduces missing and duplicate CSI rows as Red" },
    ],
    expected: "The pinned XTerm patch-411 CSI audit mechanically rejects missing required rows, duplicate selectors, missing named tests, and incomplete specification anchors.",
    levels: ["unit"],
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
      { file: "sidecars/vt-alacritty/src/engine.rs", symbol: "resize" },
    ],
    tests: [
      { file: "e2e/terminal.test.mjs", id: "three terminals survive repeated divider drags and project returns" },
      { file: "e2e/terminal.test.mjs", id: "terminal image follows a window resize" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "soft_wraps_rejoin_but_explicit_newlines_remain_after_resize" },
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
    id: "F1.4",
    implementation: [
      { file: "sidecars/vt-alacritty/src/engine.rs", symbol: "resize" },
      { file: "plugins/terminal/ui/terminal.js", symbol: "terminal.session" },
    ],
    tests: [
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "soft_wraps_rejoin_but_explicit_newlines_remain_after_resize" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "wide_cells_keep_their_width_and_text_through_reflow" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "cell_metrics_are_fixed_renderer_values_across_grid_resize" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "scrollback_keeps_recent_visible_lines_after_overflow_and_resize" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "alternate_screen_is_separate_from_primary_scrollback" },
      { file: "e2e/terminal.test.mjs", id: "terminal image follows a window resize" },
    ],
    expected: "A narrow-to-wide resize preserves the complete logical text and explicit newlines, keeps wide-cell widths and renderer metrics fixed, retains scrollback semantics and primary/alternate isolation, and keeps the PTY, DOM plane, and native raster dimensions consistent in both hosts.",
    levels: ["unit", "application"],
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
      { file: "e2e/outside.test.mjs", id: "shell divider drag does not leave a white surface frame" },
    ],
    expected: "A complete divider recording keeps native content inside its card, keeps card and rail geometry aligned, contains no white surface frame, and returns to its initial position.",
    levels: ["native", "application"],
  },
  {
    id: "F3.3",
    implementation: [
      { file: "plugins/browser/ui/browser.js", symbol: "surfaceId" },
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
    tests: [{ file: "e2e/browser.test.mjs", id: "Google site appearance remains independent of host theme" }],
    expected: "Google's explicit light site preference remains unchanged when the host switches light to dark, and its URL remains unchanged.",
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
      { file: "plugins/terminal/ui/terminal.js", symbol: "startTerminal" },
      { file: "sidecars/vt-core/src/protocol.rs", symbol: "send_state" },
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
      { file: "plugins/terminal/ui/terminal.js", symbol: "startTerminal" },
      { file: "sidecars/vt-alacritty/src/engine.rs", symbol: "fn feed_with_inline_images" },
      { file: "e2e/terminal.test.mjs", symbol: "terminal file drop pastes quoted paths without executing" },
    ],
    tests: [
      { file: "plugins/terminal/test/module.test.mjs", id: "terminal module waits for composition presentation, publishes state, and disposes the controller" },
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
      { file: "plugins/terminal/ui/terminal.js", symbol: "pasteText" },
      { file: "packages/host/tauriv2/src/clipboard.rs", symbol: "pub(crate) fn read" },
      { file: "packages/host/wailsv3/src/clipboard.go", symbol: "func (h *Host) ClipboardRead" },
    ],
    tests: [
      { file: "plugins/terminal/test/terminal.test.mjs", id: "terminal.paste quotes file URLs without adding an executable newline" },
      { file: "plugins/terminal/test/terminal.test.mjs", id: "terminal.paste persists a PNG and sends its owned shell path once" },
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
    id: "F6.3-10",
    implementation: [
      { file: "plugins/terminal/ui/terminal-module.js", symbol: "mount" },
      { file: "packages/workbench/surface-modules.js", symbol: "mountSurface" },
    ],
    tests: [
      { file: "plugins/terminal/test/module.test.mjs", id: "terminal module disposes its native composition when sidecar open fails" },
    ],
    expected: "A terminal sidecar startup failure releases its declared native composition so the failed surface reports its error without blocking the window presentation wait.",
    levels: ["unit"],
  },
  {
    id: "F7",
    implementation: [
      { file: "sidecars/vt-alacritty/src/engine.rs", symbol: "OSC_SELECTOR_INVENTORY" },
      { file: "sidecars/vt-alacritty/src/engine.rs", symbol: "impl AlacrittyEngine" },
      { file: "sidecars/vt-alacritty/src/engine.rs", symbol: "fn osc_outcome" },
      { file: "sidecars/vt-alacritty/src/engine.rs", symbol: "CSI_SELECTOR_INVENTORY" },
    ],
    tests: [
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "osc_selector_inventory_records_unsupported_operations" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "csi_inventory_links_only_executed_behavior_cases" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "csi_cursor_movement_and_save_restore_are_observable" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "every_unsupported_osc_inventory_selector_emits_an_explicit_error" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "unsupported_osc_selector_is_an_explicit_error_after_fragmented_bel" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "unsupported_osc_selector_is_an_explicit_error_after_st" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "vendor_osc_contracts_are_separate" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "osc50_cursor_shape_changes_program_cursor" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "osc104_resets_indexed_colors" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "osc_dynamic_color_resets_restore_defaults" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "osc_default_color_queries_match_renderer_defaults" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "osc_title_supports_bel_st_and_fragmentation" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "osc104_without_parameters_resets_all_indexed_colors" },
    ],
    expected: "The pinned OSC selector inventory records implemented, unsupported, and separate vendor selectors with named engine evidence; supported behaviors have executable cases and every unsupported selector emits an explicit rejection event, including fragmented BEL/ST input.",
    levels: ["unit"],
  },
  {
    id: "F6.5",
    implementation: [
      { file: "plugins/terminal/ui/terminal.js", symbol: "dropFilesFromEvent" },
      { file: "plugins/terminal/plugin.json", symbol: "terminal.drop" },
    ],
    tests: [
      { file: "plugins/terminal/test/terminal.test.mjs", id: "terminal file drop quotes local URLs and sends one non-executing paste" },
      { file: "plugins/terminal/test/terminal.test.mjs", id: "terminal file drop rejects unsupported or malformed payloads without input" },
      { file: "e2e/terminal.test.mjs", id: "terminal file drop pastes quoted paths without executing" },
    ],
    expected: "A user file drop accepts only a declared text/uri-list, validates local URLs, shell-quotes all paths, and sends one non-executing paste; unsupported and malformed drops remain explicit errors on both rebuilt hosts.",
    levels: ["unit", "application"],
  },
  {
    id: "F6.6-1",
    implementation: [{ file: "sidecars/vt-core/src/inline_image.rs", symbol: "pub fn parse" }],
    tests: [
      { file: "sidecars/vt-core/tests/inline_image_test.rs", id: "file_payload_becomes_a_bounded_inline_image_with_typed_dimensions" },
      { file: "sidecars/vt-core/tests/inline_image_test.rs", id: "malformed_size_base64_and_dimensions_are_rejected" },
      { file: "sidecars/vt-core/tests/inline_image_test.rs", id: "multipart_records_are_typed_and_do_not_become_a_display_by_fallback" },
      { file: "sidecars/vt-core/tests/inline_image_test.rs", id: "oversized_encoded_payload_is_rejected_before_decoding" },
    ],
    expected: "OSC 1337 image records produce bounded typed outcomes, reject malformed or oversized values, and preserve explicit transfer and multipart states without fallback or silent discard.",
    levels: ["unit", "native"],
  },
  {
    id: "F6.6-2",
    implementation: [
      { file: "sidecars/vt-alacritty/src/engine.rs", symbol: "fn feed_with_inline_images" },
      { file: "sidecars/vt-core/src/protocol.rs", symbol: "EngineEvent::InlineImage" },
      { file: "sidecars/vt-core/src/platform/darwin/frame.rs", symbol: "draw_with_theme_and_inline_images" },
    ],
    tests: [
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "osc1337_inline_image_is_typed_and_survives_input_chunk_boundaries" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "scroll_generation_advances_when_output_scrolls_the_primary_grid" },
      { file: "sidecars/vt-alacritty/tests/engine_test.rs", id: "malformed_osc1337_is_an_explicit_engine_error" },
      { file: "sidecars/vt-core/tests/serve_contract.rs", id: "test_inline_image_event_is_explicit_and_base64_encoded" },
      { file: "sidecars/vt-core/tests/serve_contract.rs", id: "test_inline_image_delete_is_explicit_for_unowned_names" },
      { file: "sidecars/vt-core/tests/frame_test.rs", id: "inline_image_raster_is_composited_without_erasing_terminal_background" },
    ],
    expected: "Complete OSC 1337 records, including records split across PTY output chunks, become ordered typed sidecar events with base64 image bytes; malformed records remain explicit engine errors and do not get silently dropped.",
    levels: ["unit", "native"],
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
    "@soksak/sidecar-shell", "@soksak/sidecar-vt-alacritty", "@soksak/sidecar-vt-core",
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
export function auditRustFailurePropagation(files, readSource = (file) => readFileSync(`${ROOT}${file}`, "utf8"), scope = "sidecars/vt-core/src/") {
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
      "sidecars/vt-core/src/",
      "sidecars/vt-alacritty/src/",
      "packages/host/tauriv2/src/",
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

// Aggregate review records are not capabilities and therefore do not need a
// behavior link. Every completed capability must have one otherwise.
const NON_CAPABILITY_COMPLETIONS = new Set(["G1.4-2", "V3"]);

export function auditCompletedFeatureLinks(features, checklistSource = readFileSync(`${ROOT}docs/features.md`, "utf8")) {
  const linked = new Set(features.map((feature) => feature.id));
  const completed = [...checklistSource.matchAll(/^- \[o\] ([A-Z][A-Z0-9.-]*) —/gm)].map((match) => match[1]);
  return completed
    .filter((id) => !NON_CAPABILITY_COMPLETIONS.has(id) && !linked.has(id))
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
  if (!line.includes("commit `7a3cee6`")) return ["F0.1 evidence does not identify its committed build"];
  return [];
}

export { MATRIX, repositoryFiles };

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { errors, warnings, uncoveredImplementations, uncoveredTests, featureErrors, featureLinks, trackCount, implementationCount, testCount } = auditInventory(repositoryFiles());
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
