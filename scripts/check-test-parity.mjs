// Checks the ownership of implementation and test files. This structural check does not replace behavior verification.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { components, corePackageNames } from "./check-boundaries.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const languages = {
  "js-ts": new Set([".js", ".mjs", ".ts", ".tsx"]),
  rust: new Set([".rs"]),
  go: new Set([".go"]),
  "objective-c": new Set([".m"]),
  "native-interface": new Set([".h"]),
  declaration: new Set([".json"]),
  // The build declaration is a Makefile, which has no extension.
  build: new Set(["Makefile"]),
  // A workflow declaration of the continuous integration is a YAML file.
  workflow: new Set([".yml"]),
};

// The window checks and the manifests and modules of the plugins of their fixtures (e2e/fixtures/<check>/<plugin>/), which the
// checks install into the applications.
const FIXTURE_TEST_EXTENSIONS = new Set([".mjs", ".js", ".json", ".html"]);

const lane = (capability, language, implementation, tests, options = {}) => ({
  capability,
  language,
  implementation,
  tests,
  testLanguage: options.testLanguage ?? language,
  testExtensions: options.testExtensions ?? null,
  sharedTests: options.sharedTests ?? false,
});

// The connections of existing components are also kept as a file list. They are not interpreted as behavior evidence.
const MATRIX = [
  lane("Makefile check targets", "build", ["Makefile"], ["scripts/test/rust-repeat.test.mjs", "scripts/test/windows-build-check.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("macOS application bundle preparation", "js-ts", ["scripts/platform/darwin/prepare-app-bundle.mjs"], ["scripts/test/bundle-preparation.test.mjs"], { sharedTests: true }),
  lane("CI workflows", "workflow", [".github/workflows/*.yml"], ["scripts/test/workflows.test.mjs"], { testLanguage: "js-ts" }),
  lane("native library pkg-config", "build", ["native/darwin/Makefile"], ["scripts/test/native-pkgconfig.test.mjs"], { testLanguage: "js-ts" }),
  lane("workspace audit scripts", "js-ts", [
    "scripts/check-e2e.mjs",
    "scripts/check-e2e-host-parity.mjs",
    "scripts/check-exposure.mjs",
    "scripts/check-host-parity.mjs",
  ], ["scripts/test/soksak-scripts.test.mjs", "scripts/test/e2e-host-parity.test.mjs", "scripts/test/check-host-parity.test.mjs", "scripts/test/check-exposure.test.mjs"], { sharedTests: true }),
  lane("test inventory", "js-ts", ["scripts/check-test-parity.mjs"], ["scripts/test/test-parity.test.mjs"]),
  lane("host contract audit", "js-ts", ["scripts/check-host-contract.mjs"], ["scripts/test/check-host-contract.test.mjs", "scripts/test/view-region-calls.test.mjs", "scripts/test/plugin-host-calls.test.mjs"]),
lane("command supervision", "js-ts", ["scripts/test-command.mjs"], ["scripts/test/test-command.test.mjs"]),
lane("test runner", "js-ts", ["scripts/test-runner.mjs", "scripts/rust-tests.mjs"], ["scripts/test/test-runner.test.mjs", "scripts/test/rust-repeat.test.mjs"], { sharedTests: true }),
lane("test discovery", "js-ts", ["scripts/test-discovery.mjs"], ["scripts/test/test-discovery.test.mjs"]),
lane("node tests", "js-ts", ["scripts/node-tests.mjs"], ["scripts/test/node-tests.test.mjs"]),
lane("test runs", "js-ts", ["scripts/test-runs.mjs"], ["scripts/test/test-runs.test.mjs"]),
lane("native tests", "js-ts", ["scripts/native-tests.mjs"], ["scripts/test/native-tests.test.mjs", "scripts/test/native-repeat.test.mjs"]),
lane("event log audit", "js-ts", ["scripts/check-events.mjs"], ["scripts/test/check-events.test.mjs"]),
lane("event class tables", "js-ts", ["scripts/generate-event-classes.mjs"], ["scripts/test/event-classes.test.mjs"]),
lane("run log audit", "js-ts", ["scripts/audit-run.mjs"], ["scripts/test/audit-run.test.mjs"]),
lane("log command audit", "js-ts", ["scripts/audit-log.mjs"], ["scripts/test/audit-log.test.mjs"]),
lane("temporary folder audit", "js-ts", ["scripts/temp-audit.mjs"], ["scripts/test/temp-audit.test.mjs"]),
lane("census", "declaration", ["scripts/census.json"], ["scripts/test/census.test.mjs"], { testLanguage: "js-ts" }),
lane("package bin audit", "js-ts", ["scripts/check-package-bins.mjs"], ["scripts/test/package-bins.test.mjs"]),
lane("failure table", "js-ts", ["scripts/check-failure-table.mjs"], ["scripts/test/check-failure-table.test.mjs"]),
lane("language test adapters", "js-ts", ["scripts/language-test-adapters.mjs"], ["scripts/test/test-language-test-adapters.test.mjs", "scripts/test/fixtures/node-color-count.mjs"]),
lane("language test adapter manifest", "declaration", ["scripts/language-test-cases.json"], ["scripts/test/test-language-test-manifest.test.mjs"], { testLanguage: "js-ts" }),
lane("test evidence", "js-ts", ["scripts/test-evidence.mjs"], ["scripts/test/test-evidence.test.mjs"]),
  lane("workspace version audit", "js-ts", ["scripts/check-versions.mjs"], ["scripts/test/versions.test.mjs"]),
  lane("fallback and discarded error audit", "js-ts", ["scripts/check-fallbacks.mjs"], ["scripts/test/fallbacks.test.mjs"]),
  lane("comment language audit", "js-ts", ["scripts/check-comment-language.mjs"], ["scripts/test/comment-language.test.mjs"]),
lane("push range", "js-ts", ["scripts/push-range.mjs"], ["scripts/test/push-range.test.mjs"]),
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
  lane("release migration step", "shell", ["scripts/release-step.sh"], ["scripts/test/release-step.test.mjs"]),
  lane("installed format mentions", "js-ts", ["scripts/test/format-mentions.test.mjs"], ["scripts/test/format-mentions.test.mjs"]),
  lane("page memory measurement", "js-ts", ["scripts/measure-page-memory.mjs"], ["scripts/test/measure-page-memory.test.mjs"]),
  lane("object counts measurement", "js-ts", ["scripts/measure-object-counts.mjs"], ["scripts/test/measure-object-counts.test.mjs"]),
  lane("host call memory measurement", "js-ts", ["scripts/measure-host-calls.mjs"], ["scripts/test/measure-host-calls.test.mjs"]),
  lane("application usage measurement", "js-ts", ["scripts/measure-app-usage.mjs"], ["scripts/test/measure-app-usage.test.mjs"]),
  lane("host allocation measurement", "js-ts", ["scripts/measure-host-allocations.mjs"], ["scripts/test/measure-host-allocations.test.mjs"]),
  lane("application update check", "js-ts", ["scripts/check-app-update.mjs"], ["scripts/test/check-app-update.test.mjs"]),
  lane("Go repeat tests", "js-ts", ["scripts/go-tests.mjs"], ["scripts/test/go-repeat.test.mjs"]),
  lane("Node repeat tests", "js-ts", ["scripts/node-repeat.mjs"], ["scripts/test/node-repeat.test.mjs"]),
  lane("push gate tests", "js-ts", ["scripts/gate-tests.mjs"], ["scripts/test/gate-tests.test.mjs"]),
  lane("benchmark runner tests", "js-ts", ["scripts/benchmarks.mjs"], ["scripts/test/benchmarks.test.mjs"]),
  lane("Go repeat inputs", "js-ts", ["scripts/go-repeat-inputs.mjs"], ["scripts/test/go-repeat-inputs.test.mjs"]),
  lane("workspace registry", "js-ts", ["scripts/workspace-registry.mjs"], ["scripts/test/workspace-registry.test.mjs"]),
  lane("platform boundary audit", "js-ts", ["scripts/check-platforms.mjs"], ["scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("component boundary audit", "js-ts", ["scripts/check-boundaries.mjs"], ["scripts/test/check-boundaries.test.mjs", "scripts/test/soksak-scripts.test.mjs"], { sharedTests: true }),
  lane("plugin API", "js-ts", ["packages/plugin-api/*.js"], ["packages/plugin-api/test/**/*.mjs", "scripts/test/fixture-compositions.test.mjs"]),
  lane("log contract", "js-ts", ["packages/log-contract/*.js"], ["packages/log-contract/test/**/*.mjs"]),
  lane("workbench", "js-ts", ["packages/workbench/*.js", "packages/workbench/*.mjs"], ["packages/workbench/test/**/*.js", "packages/workbench/test/**/*.mjs"], { sharedTests: true }),
  lane("declared UI benchmark", "js-ts", ["packages/workbench/benchmark/declared-ui.mjs"], ["packages/workbench/test/declared-ui-benchmark.test.mjs"], { sharedTests: true }),
  lane("client", "js-ts", [
    "packages/client/*.js",
    "packages/client/platform/**/*.js",
    "packages/client/testing/**/*.js",
    "packages/client/bench/**/*.mjs",
  ], ["packages/client/test/**/*.mjs"]),
  lane("MCP client", "js-ts", ["packages/mcp/**/*.js"], ["packages/mcp/test/**/*.mjs"]),
  lane("window check harness", "js-ts", ["packages/window-check/*.mjs"], ["packages/window-check/test/**/*.mjs"]),
  lane("audit of the running documents", "js-ts", ["e2e/audit-surfaces.mjs"], ["scripts/test/audit-surfaces.test.mjs"]),
  lane("browser runtime", "js-ts", ["apps/browser/runtime/**/*.js"], ["apps/browser/test/**/*.mjs", "apps/browser/check/**/*.mjs"], { sharedTests: true }),
  lane("Tauri runtime", "js-ts", ["apps/tauriv2/runtime/**/*.js"], ["apps/tauriv2/test/**/*.mjs"], { sharedTests: true }),
  lane("Wails runtime", "js-ts", ["apps/wailsv3/runtime/**/*.js"], ["apps/wailsv3/test/**/*.mjs"], { sharedTests: true }),

  lane("Tauri host", "rust", ["packages/host/tauriv2/src/**/*.rs", "packages/host/tauriv2/build.rs"], ["packages/host/tauriv2/tests/**/*.rs", "packages/host/tauriv2/src/object_counts_test.rs", "packages/host/tauriv2/src/composition_overlay_test.rs", "packages/host/tauriv2/src/platform/darwin/webview_overlay_test.rs", "packages/host/tauriv2/src/platform/darwin/document_test.rs", "packages/host/tauriv2/src/sidecar_reply_test.rs", "packages/host/tauriv2/src/surfaces_test.rs", "packages/host/tauriv2/src/modals_readiness_test.rs", "packages/host/tauriv2/src/exposure_status_test.rs", "packages/host/tauriv2/src/notifications_test.rs", "packages/host/tauriv2/src/project_removal_test.rs", "packages/host/tauriv2/src/endpoint_lock_test.rs", "packages/host/tauriv2/src/windows_records_test.rs", "packages/host/tauriv2/src/sidecars_lock_test.rs", "packages/host/tauriv2/src/performance_lock_test.rs", "packages/host/tauriv2/src/workspace_lock_test.rs", "packages/host/tauriv2/src/view_lifecycle_test.rs", "packages/host/tauriv2/src/view_origin_test.rs", "packages/host/tauriv2/src/view_responsiveness_test.rs", "packages/host/tauriv2/src/view_theme_test.rs", "packages/host/tauriv2/src/view_start_test.rs", "packages/host/tauriv2/src/view_call_peer_test.rs", "packages/host/tauriv2/src/document_binary_take_test.rs", "packages/host/tauriv2/src/presentation_wait_test.rs", "packages/host/tauriv2/src/view_join_test.rs", "packages/host/tauriv2/benches/**/*.rs", "packages/host/tauriv2/tests/fixtures/**/*.json", "packages/host/tauriv2/src/diagnostics_lock_test.rs", "packages/host/tauriv2/src/diagnostics_input_reference_test.rs", "packages/host/tauriv2/src/log_policy_watch_hook_lock_test.rs", "packages/host/tauriv2/src/process_lock_hook_lock_test.rs", "packages/host/tauriv2/src/assets_lock_test.rs", "packages/host/tauriv2/src/deep_link_lock_test.rs", "packages/host/tauriv2/src/log_query_lock_test.rs", "packages/host/tauriv2/src/debug_follow_lock_test.rs", "packages/host/tauriv2/src/plugin_host_test.rs", "packages/host/tauriv2/src/plugin_host_channel_test.rs", "packages/host/tauriv2/src/plugin_host_sidecar_test.rs"], { testExtensions: new Set([".rs", ".json"]) }),
  lane("Tauri application bootstrap", "rust", ["apps/tauriv2/src/main.rs", "apps/tauriv2/build.rs"], ["e2e/**/*.mjs", "e2e/fixtures/*/*/plugin.json", "e2e/fixtures/*/*/ui/*.js", "e2e/fixtures/*/*/ui/*.html"], { testLanguage: "js-ts", testExtensions: FIXTURE_TEST_EXTENSIONS, sharedTests: true }),

  lane("Wails host", "go", ["packages/host/wailsv3/src/**/*.go"], ["packages/host/wailsv3/tests/**/*.go", "packages/host/wailsv3/tests/fixtures/**/*.json", "packages/host/wailsv3/src/diagnostics_test.go", "packages/host/wailsv3/src/composition_overlay_test.go", "packages/host/wailsv3/src/platform/darwin/webview_overlay_test.go", "packages/host/wailsv3/src/platform/darwin/document_test.go", "packages/host/wailsv3/src/platform/darwin/input_reference_test.go", "packages/host/wailsv3/src/exposure_status_test.go", "packages/host/wailsv3/src/modals_readiness_test.go", "packages/host/wailsv3/src/object_counts_test.go", "packages/host/wailsv3/src/view_lifecycle_test.go", "packages/host/wailsv3/src/view_responsiveness_test.go", "packages/host/wailsv3/src/view_theme_test.go", "packages/host/wailsv3/src/view_start_test.go", "packages/host/wailsv3/src/view_call_peer_test.go", "packages/host/wailsv3/src/document_binary_take_test.go", "packages/host/wailsv3/src/presentation_wait_test.go", "packages/host/wailsv3/src/view_join_test.go", "packages/host/wailsv3/src/sidecar_reply_test.go", "packages/host/wailsv3/src/surfaces_test.go", "packages/host/wailsv3/src/plugin_host_test.go", "packages/host/wailsv3/src/plugin_host_channel_test.go", "packages/host/wailsv3/src/source_origins_test.go", "packages/host/wailsv3/src/plugin_host_sidecar_test.go"], { sharedTests: true, testExtensions: new Set([".go", ".json"]) }),
  lane("Wails command line", "go", ["packages/sok/wailsv3/src/**/*.go"], ["packages/sok/wailsv3/tests/**/*.go", "packages/sok/wailsv3/src/diagnostics_test.go", "packages/sok/wailsv3/src/dev_test.go", "packages/sok/wailsv3/src/debug_test.go", "packages/sok/wailsv3/src/migrate_format_test.go", "packages/sok/wailsv3/src/event_log_loss_test.go"]),
  lane("Tauri command line", "rust", ["packages/sok/tauriv2/src/**/*.rs"], ["packages/sok/tauriv2/tests/**/*.rs", "packages/sok/tauriv2/src/event_log_lock_test.rs", "packages/sok/tauriv2/src/debug_test.rs", "packages/sok/tauriv2/src/migrate_format_test.rs", "packages/sok/tauriv2/src/event_log_loss_test.rs"]),
  lane("Wails application bootstrap", "go", ["apps/wailsv3/src/main.go"], ["e2e/**/*.mjs", "e2e/fixtures/*/*/plugin.json", "e2e/fixtures/*/*/ui/*.js", "e2e/fixtures/*/*/ui/*.html"], { testLanguage: "js-ts", testExtensions: FIXTURE_TEST_EXTENSIONS, sharedTests: true }),

  lane("Darwin clipboard", "objective-c", ["native/darwin/src/clipboard.m"], ["native/darwin/tests/clipboard_test.m"], { sharedTests: true }),
  lane("Darwin link open", "objective-c", ["native/darwin/src/link.m"], ["native/darwin/tests/link_test.m"], { sharedTests: true }),
  lane("Darwin diagnostic reports folder", "objective-c", ["native/darwin/src/diagnostic_reports.m"], ["native/darwin/tests/diagnostic_reports_test.m"], { sharedTests: true }),
  lane("Darwin activity observers", "objective-c", ["native/darwin/src/activity_observers.m"], ["native/darwin/tests/activity_observers_test.m"], { sharedTests: true }),
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
    "native/darwin/src/input_reference.m",
    "native/darwin/src/webview_input.m",
  ], [
    "native/darwin/tests/image_region_ime_test.m",
    "native/darwin/tests/input_activate_test.m",
    "native/darwin/tests/input_reference_test.m",
    "native/darwin/tests/input_inject_test.m",
    "native/darwin/tests/webview_focus_test.m",
    "native/darwin/tests/webview_input_test.m",
  ], { sharedTests: true }),
  lane("Darwin window", "objective-c", ["native/darwin/src/window_*.m"], ["native/darwin/tests/window_*_test.m"], { sharedTests: true }),
  lane("Darwin UI queue", "objective-c", ["native/darwin/src/ui_queue.m"], ["native/darwin/tests/ui_queue_test.m"], { sharedTests: true }),
  lane("Darwin process exit", "objective-c", ["native/darwin/src/process_exit.m"], ["native/darwin/tests/process_exit_test.m"], { sharedTests: true }),
  lane("Darwin application log", "objective-c", ["native/darwin/src/application_log.m"], ["native/darwin/tests/application_log_test.m"], { sharedTests: true }),
  lane("Darwin event ring", "objective-c", ["native/darwin/src/event_ring.m"], ["native/darwin/tests/event_ring_test.m"], { sharedTests: true }),
  lane("Darwin observe", "objective-c", ["native/darwin/src/observe.m"], ["native/darwin/tests/observe_test.m"], { sharedTests: true }),
  lane("Darwin mouse buttons", "objective-c", ["native/darwin/src/mouse_buttons.m"], ["native/darwin/tests/mouse_buttons_test.m"], { sharedTests: true }),
  lane("Darwin quit request", "objective-c", ["native/darwin/src/quit_request.m"], ["native/darwin/tests/quit_request_test.m"], { sharedTests: true }),
  lane("Darwin memory pressure", "objective-c", ["native/darwin/src/memory_pressure.m"], ["native/darwin/tests/memory_pressure_test.m", "native/darwin/tests/document_backforward_test.m"], { sharedTests: true }),
  lane("Darwin process identity", "objective-c", ["native/darwin/process-identity/src/process_identity.m"], ["native/darwin/process-identity/tests/**/*.m", "native/darwin/process-identity/tests/**/*.sh"], { testExtensions: new Set([".m", ".sh"]) }),
  lane("Darwin webview navigation", "objective-c", ["native/darwin/src/webview_navigation.m"], ["native/darwin/tests/webview_navigation_test.m"], { sharedTests: true }),
  lane("Darwin capture", "objective-c", ["native/darwin/src/capture.m"], ["native/darwin/tests/capture_test.m", "native/darwin/tests/capture_pressure_test.m", "native/darwin/tests/capture_metadata_test.m", "native/darwin/tests/capture_resize_test.m", "native/darwin/tests/capture_checker_test.m", "native/darwin/tests/capture_file_checker_test.m", "native/darwin/tests/capture_storage_test.m", "native/darwin/tests/capture_frame_test.m", "native/darwin/tests/capture_lifecycle_test.m", "native/darwin/tests/capture_preparation_test.m", "native/darwin/tests/capture_cleanup_test.m", "native/darwin/tests/capture_callback_test.m"], { sharedTests: true }),
  lane("Darwin dock menu", "objective-c", ["native/darwin/src/dock_menu.m"], ["native/darwin/tests/dock_menu_test.m"], { sharedTests: true }),
  lane("Darwin appearance", "objective-c", ["native/darwin/src/appearance.m"], ["native/darwin/tests/appearance_test.m"], { sharedTests: true }),
  lane("Darwin native interfaces", "native-interface", ["native/darwin/src/**/*.h", "native/darwin/process-identity/**/*.h"], ["native/darwin/tests/**/*.m", "native/darwin/tests/support/*.h"], { testLanguage: "objective-c", sharedTests: true, testExtensions: new Set([".m", ".mm", ".h"]) }),
  lane("browser environment declaration", "declaration", ["apps/browser/environment.json"], ["apps/browser/test/environment.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Tauri environment declaration", "declaration", ["apps/tauriv2/environment.json"], ["apps/tauriv2/test/environment.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Wails environment declaration", "declaration", ["apps/wailsv3/environment.json"], ["apps/wailsv3/test/environment.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Wails bridge", "js-ts", ["packages/host/wailsv3/src/bridge.js"], ["apps/wailsv3/test/runtime-contract.test.mjs"], { sharedTests: true }),
  lane("Wails native webview bridge", "objective-c", ["packages/host/wailsv3/src/platform/darwin/webview.m"], ["packages/host/wailsv3/tests/documents_test.go"], { testLanguage: "go", sharedTests: true }),
  lane("Workbench styles", "stylesheet", ["packages/workbench/app.css", "packages/workbench/library.css"], ["packages/workbench/test/background.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Workbench declarations", "declaration", ["packages/workbench/exposure.json"], ["packages/workbench/test/exposure.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
  lane("Workbench shortcuts", "declaration", ["packages/workbench/shortcuts.json"], ["scripts/test/shortcut-table.test.mjs"], { testLanguage: "js-ts" }),
  lane("Workbench documents", "document", ["packages/workbench/index.html", "packages/workbench/overlay.html"], ["packages/workbench/test/published-imports.test.mjs"], { testLanguage: "js-ts", sharedTests: true }),
];

// A feature link is stronger than a file owner: it names the implementation, the behavior test,
// the expected result, and the verification level of one feature.
// The inventory remains structural, and the behavior is proved by the referenced test.
const FEATURE_LINKS = [
  {
    id: "F212.12-1-23",
    implementation: [
      { file: "packages/plugin-api/view.js", symbol: "observeSurfaceDocument" },
      { file: "packages/plugin-api/surface-document.js", symbol: "auditDocument" },
      { file: "packages/workbench/exposure.js", symbol: "options.surfaceFrame(surface)" },
    ],
    tests: [
      { file: "packages/plugin-api/test/view-document.test.mjs", id: "the bridge registers the actual view document without plugin exposure setup" },
      { file: "packages/plugin-api/test/view-document.test.mjs", id: "document watchers observe delegated shadow controls and mutations and close after unwatch" },
      { file: "packages/workbench/test/exposure.test.mjs", id: "a view rectangle uses the selected surface's current applied origin once" },
      { file: "packages/workbench/test/exposure.test.mjs", id: "the surface menu command is owned by the main document" },
    ],
    expected: "The actual view owns its document, input and hit entries once, its audit includes shared binders and open shadow roots, and view rectangles add the current applied origin once while the main document retains its menu command.",
    levels: ["unit"],
  },
  {
    id: "F212.12-1-10-5",
    implementation: [{ file: "packages/plugin-api/view-modules.js", symbol: "export function checkViewModules" }],
    tests: [
      { file: "packages/plugin-api/test/view-modules.test.mjs", id: "a string literal of a minified vendor bundle that reads as an import is not an import" },
      { file: "packages/plugin-api/test/view-modules.test.mjs", id: "a module that imports a specifier outside the view import map is an error that names the module and the specifier" },
    ],
    expected: "The module graph rule of a view page reads only the code of each module with es-module-lexer, so a string literal of a bundle is not an import, and it still refuses an unmapped static, re-export or literal dynamic import.",
    levels: ["unit"],
  },
  {
    id: "F260-1",
    implementation: [
      { file: "packages/sok/wailsv3/src/ownership.go", symbol: "func ownConfiguration" },
      { file: "packages/sok/tauriv2/src/ownership.rs", symbol: "fn own_configuration" },
      { file: "packages/sok/wailsv3/src/platform/darwin/process.go", symbol: "func (darwin) TryLockFile" },
      { file: "packages/sok/wailsv3/src/platform/linux/process.go", symbol: "func (linux) TryLockFile" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/process_lock_cases_test.go", id: "TestAWritingCommandReadsTheProcessLockCaseTable" },
      { file: "packages/sok/tauriv2/tests/process_lock_cases_test.rs", id: "a_writing_command_reads_the_process_lock_case_table" },
      { file: "packages/host/wailsv3/tests/process_lock_cases_test.go", id: "TestTheHostRefusesAHeldLockOfEachCaseWithItsText" },
      { file: "packages/host/tauriv2/tests/process_lock_cases_test.rs", id: "the_host_refuses_a_held_lock_of_each_case_with_its_text" },
    ],
    expected: "A writing command of sok holds the advisory lock on process.lock for the whole command, refuses a held lock with the host text of its case, and takes over a free lock file, in both sok implementations; the host refuses the same held cases with the same texts.",
    levels: ["unit"],
  },
  {
    id: "F260",
    implementation: [
      { file: "packages/sok/wailsv3/src/ownership.go", symbol: "func parseLockOwner" },
      { file: "packages/sok/tauriv2/src/ownership.rs", symbol: "fn parse_lock_owner" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/process_lock_cases_test.go", id: "TestAWritingCommandReadsTheProcessLockCaseTable" },
      { file: "packages/sok/tauriv2/tests/process_lock_cases_test.rs", id: "a_writing_command_reads_the_process_lock_case_table" },
    ],
    expected: "A writing command of sok reads process.lock in the form of the host: a live owner is refused with its pid, an ended owner is taken over, and a lock in another form is refused with its content named and kept, in both implementations.",
    levels: ["unit"],
  },
  {
    id: "F212.6a-1-3-2-3",
    implementation: [
      { file: "packages/host/tauriv2/src/stall_watch.rs", symbol: "pub fn start_stall_watch" },
      { file: "packages/host/wailsv3/src/stall_watch.go", symbol: "func StartStallWatch" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/stall_watch_test.rs", id: "a_stall_of_an_unscheduled_process_carries_its_lateness_in_the_watch" },
      { file: "packages/host/tauriv2/tests/stall_watch_test.rs", id: "a_stall_of_a_blocked_main_thread_has_no_lateness_in_the_watch" },
      { file: "packages/host/wailsv3/tests/stall_watch_test.go", id: "TestAStallOfAnUnscheduledProcessCarriesItsLatenessInTheWatch" },
      { file: "packages/host/wailsv3/tests/stall_watch_test.go", id: "TestAStallOfABlockedMainThreadHasNoLatenessInTheWatch" },
    ],
    expected: "Both hosts record host.stall with watch_late_ms, the lateness of the watch's own wake, so that a stall of an unscheduled process has a watch lateness of at least half its lateness and a blocked main thread has none.",
    levels: ["unit"],
  },
  {
    id: "F258-2",
    implementation: [{ file: "scripts/check-boundaries.mjs", symbol: "export function checkTestPathReads" }],
    tests: [{ file: "scripts/test/check-boundaries.test.mjs", id: "checkTestPathReads refuses a test that reads a path of another core package" }],
    expected: "make boundaries refuses a test of a core package whose string resolves into another core package, and the shared contract text of the manifest case table is read from docs/spec/cases, which no package owns.",
    levels: ["unit"],
  },
  {
    id: "F258-3",
    implementation: [{ file: "scripts/audit-log.mjs", symbol: "auditLog" }],
    tests: [
      { file: "packages/host/wailsv3/tests/event_log_test.go", id: "TestTheEventLogPassesTheAuditOfTheContractPackage" },
      { file: "packages/host/tauriv2/tests/event_log_test.rs", id: "the_file_passes_the_audit_of_the_contract_package" },
    ],
    expected: "The host tests audit their logs through the repository command, the log-contract fixtures are read from docs/spec/cases, and no test of a core package reads the fixtures or the audit module of another package by path.",
    levels: ["unit"],
  },
  {
    id: "F258-1",
    implementation: [
      { file: "packages/sok/wailsv3/src/manifest.go", symbol: "func ValidateManifest" },
      { file: "packages/sok/tauriv2/src/manifest.rs", symbol: "pub fn validate_manifest" },
      { file: "packages/plugin-api/index.js", symbol: "function sortedEntries" },
    ],
    tests: [
      { file: "packages/plugin-api/test/manifest-validation.test.mjs", id: "manifest validation" },
      { file: "packages/sok/wailsv3/tests/manifest_cases_test.go", id: "TestPluginPackReplaysTheManifestCases" },
      { file: "packages/sok/wailsv3/tests/manifest_cases_test.go", id: "TestPluginInstallReplaysTheRefusedManifestCases" },
      { file: "packages/sok/tauriv2/tests/manifest_cases_test.rs", id: "plugin_pack_replays_the_manifest_cases" },
      { file: "packages/sok/tauriv2/tests/manifest_cases_test.rs", id: "plugin_install_replays_the_refused_manifest_cases_of_the_probe" },
    ],
    expected: "The reader and both sok implementations give every case of docs/spec/cases/manifest-validation.json the same result: a refused manifest fails with the reader's text, members are read in sorted key order, and a schema type that is not a type name is refused.",
    levels: ["unit"],
  },
  {
    id: "F258",
    implementation: [{ file: "packages/sok/wailsv3/src/manifest.go", symbol: "func ValidateManifest" }],
    tests: [
      { file: "packages/sok/wailsv3/tests/release_test.go", id: "TestPluginPackRefusesASchemaOutsideTheSubset" },
      { file: "packages/sok/wailsv3/tests/plugins_test.go", id: "TestPluginInstallRefusesAManifestWithASchemaOutsideTheSubset" },
      { file: "packages/sok/tauriv2/tests/release_test.rs", id: "plugin_pack_refuses_a_schema_outside_the_subset" },
      { file: "packages/sok/tauriv2/tests/plugins_test.rs", id: "plugin_install_refuses_a_manifest_with_a_schema_outside_the_subset" },
    ],
    expected: "The pack and the install of sok refuse a plugin.json whose exposes declaration or surface params schema the reader refuses, with the reader's error text, in both the Go and the Rust implementation.",
    levels: ["unit"],
  },
  {
    id: "F252-2",
    implementation: [{ file: "packages/host/wailsv3/src/endpoint.go", symbol: "func (e *Endpoint) accept" }],
    tests: [
      { file: "packages/host/wailsv3/tests/endpoint_test.go", id: "TestEndpointRecordsAnAcceptError" },
      { file: "packages/host/wailsv3/tests/endpoint_test.go", id: "TestEndpointRecordsAReadErrorInsideAFrame" },
      { file: "packages/host/tauriv2/tests/endpoint_test.rs", id: "the_endpoint_records_an_accept_error" },
    ],
    expected: "Both hosts record an endpoint accept error and the I/O reason of a read error instead of hiding them, each checked by a Go and a Rust test; the other host and native error paths of F252-2 are recorded in the item with their tests.",
    levels: ["unit"],
  },
  {
    id: "F257-3",
    implementation: [{ file: "scripts/test-runner.mjs", symbol: "function signalGroup" }],
    tests: [
      { file: "scripts/test/test-runner.test.mjs", id: "a refused group signal with no running member ends without error" },
      { file: "scripts/test/test-runner.test.mjs", id: "a refused group signal with a running member names it" },
    ],
    expected: "A group signal that macOS refuses with EPERM because only zombies remain ends without error, and a refusal while a member runs fails with the running members named, so the runner's exit and timeout paths do not throw on a group of zombies.",
    levels: ["unit"],
  },
  {
    id: "F257-1",
    implementation: [{ file: "scripts/test-runner.mjs", symbol: "function runOne" }],
    tests: [{ file: "scripts/test/test-runner.test.mjs", id: "a test over its limit is stopped before the process table is read, and its elapsed time is taken at the stop" }],
    expected: "At its limit the runner stops the test process group with SIGSTOP before it lists the leftovers, takes the elapsed time of the timeout at that stop, and then kills the group, so a slow process-table read does not let the test run past its limit.",
    levels: ["unit"],
  },
  {
    id: "F257",
    implementation: [{ file: "scripts/test-command.mjs", symbol: "export function runCommand" }],
    tests: [
      { file: "scripts/test/test-command.test.mjs", id: "ends its own leader when every process-group signal is refused" },
      { file: "scripts/test/test-command.test.mjs", id: "reports process-group signal failure without an unhandled timer error" },
    ],
    expected: "When a process-group signal is refused, the command runner ends its leader and finishes at the leader's close, so no child of the test process remains after the result, checked by the leader test and the signal-failure test.",
    levels: ["unit"],
  },
  {
    id: "F255",
    implementation: [{ file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", symbol: "fn a_replaced_service_starts_after_the_end_of_its_process" }],
    tests: [{ file: "packages/host/tauriv2/tests/sidecars_transport_test.rs", id: "a_replaced_service_starts_after_the_end_of_its_process" }],
    expected: "The replace service fixture waits for the installed service process to end before its drop returns, so the test that reads the process state after drop passes in every repeat run.",
    levels: ["unit"],
  },
  {
    id: "F252-1-1",
    implementation: [{ file: "packages/plugin-api/index.js", symbol: "export function createExpose" }],
    tests: [
      { file: "packages/plugin-api/test/exposure.test.mjs", id: "a port without report is refused when the exposure is created, because a failed reply needs a place to be reported" },
      { file: "packages/plugin-api/test/exposure.test.mjs", id: "a report that fails is given with both errors to reportError, which dispatches the page error event" },
    ],
    expected: "createExpose refuses a port without report, reports a refused reply through it, and gives a failing report with both texts to reportError, each checked by a plugin-api test.",
    levels: ["unit"],
  },
  {
    id: "F254",
    implementation: [{ file: "scripts/test-runner.mjs", symbol: "export async function runTests" }],
    tests: [
      { file: "scripts/test/test-runner.test.mjs", id: "a test file that leaves a timer open after its tests pass is ended at its limit, and the timeout names the process that remains" },
      { file: "scripts/test/test-runner.test.mjs", id: "a process that outlives its test process is ended at that exit, and the failure names it" },
    ],
    expected: "The test runner ends a process group that a test file leaves running and fails that file with the names of the processes, at the exit of the file process or at its limit, checked by two runner tests.",
    levels: ["unit"],
  },
  {
    id: "F249",
    implementation: [
      { file: "packages/workbench/command-route.js", symbol: "export function runCommandCall" },
      { file: "packages/workbench/plugin-host.js", symbol: "export function listenPluginHostCalls" },
      { file: "packages/host/wailsv3/src/plugin_host_channel.go", symbol: "func servedPluginHostCall" },
      { file: "packages/host/tauriv2/src/plugin_host_channel.rs", symbol: "pub fn forwarded_call" },
    ],
    tests: [
      { file: "packages/workbench/test/plugin-host-calls.test.mjs", id: "runtime.command runs a core command through runCore and a command of the plugin through runOwned, with the checks of the view call" },
      { file: "packages/workbench/test/plugin-host-calls.test.mjs", id: "runtime.log writes the record of the plugin through its log with the checks of the plugin context" },
      { file: "packages/host/wailsv3/src/plugin_host_channel_test.go", id: "TestPluginHostChannelForwardsTheCommandCall" },
      { file: "packages/host/wailsv3/src/plugin_host_channel_test.go", id: "TestPluginHostChannelForwardsTheLogCall" },
      { file: "packages/host/tauriv2/src/plugin_host_channel_test.rs", id: "the_host_forwards_the_command_call_to_the_main_page" },
      { file: "packages/host/tauriv2/src/plugin_host_channel_test.rs", id: "the_host_forwards_the_log_call_to_the_main_page" },
    ],
    expected: "A plugin host page runs a command with runtime.command and writes an event with runtime.log; both hosts forward the calls and the main page answers them with the checks of the view calls, each checked by a workbench, a Go and a Rust test.",
    levels: ["unit"],
  },
  {
    id: "F248-8",
    implementation: [
      { file: "packages/workbench/declared-section.js", symbol: "export function createDeclaredSection" },
      { file: "packages/workbench/page-layout.js", symbol: "export function reportUncaught" },
    ],
    tests: [
      { file: "packages/workbench/test/declared-section.test.mjs", id: "a failed pull leaves the section cleared, reports its error once, and is not retried" },
      { file: "packages/workbench/test/sidebar-sections.test.mjs", id: "a declared section whose pull fails reports the error once through the page error event and draws nothing" },
      { file: "packages/workbench/test/page-error-display.test.mjs", id: "an error event without a source location writes no location detail" },
    ],
    expected: "A failed declared pull leaves the section cleared, reports its error once through the page error event, is not retried on a timer, and an error event without a source location writes no location detail, each checked by a workbench test.",
    levels: ["unit"],
  },
  {
    id: "F248-7",
    implementation: [
      { file: "packages/plugin-api/view.js", symbol: "export function createViewBridge" },
      { file: "packages/plugin-api/snapshots.js", symbol: "export function createSnapshotSender" },
    ],
    tests: [
      { file: "packages/plugin-api/test/view-snapshot-pull-contract.test.mjs", id: "view snapshot pull contract publishes the required cases in order" },
    ],
    expected: "The view answers a declared UI snapshot pull with seq 0 and value null only when the store has no value, and answers any other store error with that error and reports it, replayed against the bridge with a test-controlled store fault.",
    levels: ["unit"],
  },
  {
    id: "F248-6",
    implementation: [
      { file: "packages/plugin-api/view.js", symbol: "export function createViewBridge" },
      { file: "packages/plugin-api/snapshots.js", symbol: "export function createSnapshotSender" },
    ],
    tests: [
      { file: "packages/plugin-api/test/view-tab-calls-contract.test.mjs", id: "view tab call contract publishes the required cases in order" },
      { file: "packages/plugin-api/test/view-snapshot-pull-contract.test.mjs", id: "view snapshot pull contract publishes the required cases in order" },
    ],
    expected: "The view bridge posts each tab call with its parameters and passes the host reply and refusal through, and it answers a declared UI snapshot pull with the pushed value or with seq 0 and value null, each replayed against the bridge with the same outputs.",
    levels: ["unit"],
  },
  {
    id: "F248-5",
    implementation: [
      { file: "packages/plugin-api/view.js", symbol: "export function createViewBridge" },
    ],
    tests: [
      { file: "packages/plugin-api/test/view-settings-contract.test.mjs", id: "view settings contract publishes the required cases in order" },
    ],
    expected: "The view bridge reads the settings and the text scale, delivers each host change to the listeners of its name, refuses a listener-less subscription, and removes the listener of a refused subscription, each replayed against the bridge with the same outputs.",
    levels: ["unit"],
  },
  {
    id: "F248-4",
    implementation: [
      { file: "packages/plugin-api/calls.js", symbol: "export function createCalls" },
    ],
    tests: [
      { file: "packages/plugin-api/test/calls-contract.test.mjs", id: "call limit contract publishes the required cases in order" },
    ],
    expected: "A call that receives no reply within its declared or default limit is rejected with -32000 and the limit message, and a reply after the limit is a late reply that is not passed to the call, each replayed against the call layer with mock timers and the same outputs.",
    levels: ["unit"],
  },
  {
    id: "F248-3",
    implementation: [
      { file: "packages/plugin-api/index.js", symbol: "export function createExpose" },
    ],
    tests: [
      { file: "packages/plugin-api/test/expose-contract.test.mjs", id: "exposure contract publishes the required cases in order" },
    ],
    expected: "After dispose, an exposure refuses a registration or a binding and adds no request listener, including when dispose runs while the declarations load, and the removal of bindings at dispose is published as a case that replays against the implementation with the same outputs.",
    levels: ["unit"],
  },
  {
    id: "F248-2",
    implementation: [
      { file: "packages/plugin-api/index.js", symbol: "export function resolveContributions" },
      { file: "packages/plugin-api/view.js", symbol: "export function createViewBridge" },
    ],
    tests: [
      { file: "packages/plugin-api/test/contributions-contract.test.mjs", id: "contributions contract publishes the required cases in order" },
      { file: "packages/plugin-api/test/view-native-contract.test.mjs", id: "view native contract publishes the required cases in order" },
    ],
    expected: "The contribution cases resolve every state of resolveContributions, and the view native case drops an event that arrives before its subscription, each against the implementation with the same outputs.",
    levels: ["unit"],
  },
  {
    id: "F248-1",
    implementation: [
      { file: "packages/plugin-api/index.js", symbol: "export function createExpose" },
      { file: "packages/plugin-api/surface-composition.js", symbol: "export async function createSurfaceCompositionController" },
    ],
    tests: [
      { file: "packages/plugin-api/test/expose-contract.test.mjs", id: "exposure contract publishes the required cases in order" },
      { file: "packages/plugin-api/test/view-composition-contract.test.mjs", id: "view composition contract publishes the required cases in order" },
    ],
    expected: "The exposure case disposes a registration and answers no request after dispose, and the view composition cases replay a document region load and post alone and the teardown of a composition, each against the implementation with the same outputs.",
    levels: ["unit"],
  },
  {
    id: "F248",
    implementation: [
      { file: "packages/plugin-api/binder.js", symbol: "export function createBinder" },
      { file: "packages/plugin-api/surface-composition.js", symbol: "export async function createSurfaceCompositionController" },
    ],
    tests: [
      { file: "packages/plugin-api/test/create-binder-contract.test.mjs", id: "createBinder publishes ordered cases for its consumer contract" },
      { file: "packages/plugin-api/test/view-composition-contract.test.mjs", id: "view composition contract publishes the required cases in order" },
    ],
    expected: "The binder cases bind a keydown event with its when predicate and failed callback, and the view composition cases replay the message listener, stream subscription with close, and reload of a document region, each against the implementation with the same outputs.",
    levels: ["unit"],
  },
  {
    id: "F246",
    implementation: [
      { file: "packages/plugin-api/view.js", symbol: "export function createViewBridge" },
      { file: "packages/plugin-api/index.js", symbol: "export function createExpose" },
      { file: "packages/plugin-api/surface-composition.js", symbol: "export async function createSurfaceCompositionController" },
      { file: "packages/plugin-api/binder.js", symbol: "export const INTERACTIVE" },
      { file: "packages/plugin-api/snapshots.js", symbol: "export function createSnapshotSender" },
    ],
    tests: [
      { file: "packages/plugin-api/test/view-composition-contract.test.mjs", id: "view composition contract publishes the required cases in order" },
      { file: "packages/plugin-api/test/expose-contract.test.mjs", id: "exposure contract publishes the required cases in order" },
      { file: "packages/plugin-api/test/command-registration-contract.test.mjs", id: "command registration contract publishes the required cases in order" },
      { file: "packages/plugin-api/test/view-commands-contract.test.mjs", id: "view command contract publishes the required cases in order" },
      { file: "packages/plugin-api/test/view-native-contract.test.mjs", id: "view native contract publishes the required cases in order" },
      { file: "packages/plugin-api/test/declared-ui-snapshot-contract.test.mjs", id: "declared UI snapshot contract publishes the required cases in order" },
      { file: "packages/plugin-api/test/interactive-contract.test.mjs", id: "INTERACTIVE is the published selector of operable elements" },
    ],
    expected: "Each published case file lists its ordered steps, and the owning test runs each case against the implementation with the same outputs.",
    levels: ["unit"],
  },
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
    ],
    tests: [
      { file: "e2e/projects.test.mjs", id: "project windows persist files, inherit settings, and isolate native state" },
      { file: "e2e/normal-shutdown.mjs", id: "normal-shutdown" },
    ],
    expected: "Command settling waits for the composition declaration of a view without waiting on native presentation, so surface startup cannot form a presentation cycle; project-window and normal-shutdown evidence must pass independently.",
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
      { file: "packages/plugin-api/surface-document.js", symbol: "unbound" },
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
      { file: "packages/host/tauriv2/tests/panic_hook_test.rs", id: "the_panic_hook_does_not_wait_for_the_writer_and_the_record_is_stored_before_the_process_ends" },
      { file: "packages/host/wailsv3/tests/routine_test.go", id: "TestAPanicOfAGoroutineIsRecordedAsAnEventBeforeTheProcessEnds" },
      { file: "packages/host/tauriv2/tests/routine_test.rs", id: "a_panic_of_a_thread_is_recorded_as_an_event_before_the_process_ends" },
      { file: "packages/host/tauriv2/tests/fatal_signal_test.rs", id: "a_fatal_signal_writes_an_error_line_to_the_standard_error_file" },
    ],
    expected: "The end of a page process, a lost connection to a persistent service, a fatal signal each write one error line to the application log, and a panic of a goroutine or a thread is the event `host.panic`.",
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
      { file: "packages/host/wailsv3/src/event_relay.go", symbol: "func LogCommand" },
      { file: "packages/host/tauriv2/src/event_relay.rs", symbol: "pub fn log_command" },
      { file: "packages/window-check/event-log.mjs", symbol: "export function eventLine" },
      { file: "native/darwin/src/application_log.m", symbol: "void sp_log_info" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/event_relay_test.go", id: "TestARelayedBatchReturnsTheTranscriptLinesOfItsPageRecords" },
      { file: "packages/host/tauriv2/tests/event_relay_test.rs", id: "a_relayed_batch_returns_the_transcript_lines_of_its_page_records" },
      { file: "packages/window-check/test/event-log.test.mjs", id: "a record event reads as the line of the text form, and another event as its name and fields" },
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
      { file: "scripts/test/versions.test.mjs", id: "every declared workspace version is the release candidate" },
    ],
    expected: "Every declared workspace version is the version of the release that carries the records of the application log.",
    levels: ["unit"],
  },
  {
    id: "F150.4.2",
    implementation: [
      { file: "packages/plugin-api/plugin-runtime.js", symbol: "export function createPluginRuntime" },
      { file: "packages/workbench/page-log.js", symbol: "export function captureConsole" },
    ],
    tests: [
      { file: "packages/plugin-api/test/surface.test.mjs", id: "surface context logs an event of the plugin at each level with the surface in its fields" },
      { file: "packages/workbench/test/page-log.test.mjs", id: "captureConsole records what the page writes to its console and keeps the console working" },
      { file: "packages/host/wailsv3/tests/event_relay_test.go", id: "TestARelayedBatchStoresAPluginEventInTheLayerPlugin" },
      { file: "packages/host/tauriv2/tests/event_relay_test.rs", id: "a_relayed_batch_stores_a_plugin_event_in_the_layer_plugin" },
    ],
    expected: "A plugin stores events plugin.<plugin>.<event> through its context, the page stores its console output as events, and the host stores each in the layer of its prefix.",
    levels: ["unit"],
  },
  {
    id: "F150.4.1",
    implementation: [
      { file: "packages/workbench/page-log.js", symbol: "export function reportRecord" },
      { file: "packages/workbench/log-batch.js", symbol: "export function createEventBatcher" },
    ],
    tests: [
      { file: "packages/workbench/test/page-log.test.mjs", id: "a failure is the event page.record.error with the place and the text, and the wait ends when it was relayed" },
      { file: "packages/workbench/test/log-batch.test.mjs", id: "emitAndWait ends when the batch that carries the event was relayed, and the events of one turn share the batch" },
      { file: "apps/wailsv3/test/runtime-contract.test.mjs", id: "Wails page regions expose operations but only composition places geometry" },
      { file: "e2e/host-records.test.mjs", id: "the event log holds the run record and the records the page reports" },
    ],
    expected: "A failure and an observation of the page are events page.record.<level> relayed in a batch of the host call log, and the host call report does not exist.",
    levels: ["unit", "application"],
  },
  {
    id: "F150.3.6",
    implementation: [
      { file: "packages/host/tauriv2/src/application_log.rs", symbol: "pub struct Entry" },
      { file: "packages/host/wailsv3/src/application_log.go", symbol: "type Entry struct" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/application_log_test.rs", id: "a_record_is_one_line_and_escapes_a_line_feed" },
      { file: "packages/host/tauriv2/tests/images_test.rs", id: "presentation_outcome_names_the_current_frame_of_a_failure" },
      { file: "packages/host/wailsv3/tests/event_relay_test.go", id: "TestARelayedBatchReturnsTheTranscriptLinesOfItsPageRecords" },
    ],
    expected: "A record travels as a structured entry that is stored as an event and shown as its line, in both hosts.",
    levels: ["unit"],
  },
  {
    id: "F150.3.5.2",
    implementation: [
      { file: "packages/host/wailsv3/src/event_record.go", symbol: "func emitTrace" },
      { file: "packages/host/tauriv2/src/event_record.rs", symbol: "pub fn emit_trace" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/event_record_test.go", id: "TestAHostObservationOfTheTraceIsAnEvent" },
      { file: "packages/host/tauriv2/tests/event_record_test.rs", id: "a_host_observation_of_the_trace_is_an_event" },
    ],
    expected: "An observation of the host or the sampler is stored as an event of the event log without the name in its fields, and an observation without a name is reported.",
    levels: ["unit"],
  },
  {
    id: "F150.3.5.1",
    implementation: [
      { file: "packages/workbench/performance.js", symbol: "export function createTracer" },
      { file: "packages/window-check/event-log.mjs", symbol: "export function traceRows" },
    ],
    tests: [
      { file: "packages/workbench/test/performance.test.mjs", id: "an enabled trace relays its events of one turn in one log call, and the line has no timestamp of its own" },
      { file: "packages/host/wailsv3/tests/performance_test.go", id: "TestTheSwitchAcceptsOnAndOffOnly" },
      { file: "packages/host/tauriv2/tests/performance_test.rs", id: "the_switch_accepts_on_and_off_only" },
      { file: "e2e/settings.test.mjs", id: "performance tracing records enabled card focus and stops while disabled" },
    ],
    expected: "The trace of the page leaves as events of one batch through the call log, the switch accepts on and off only, and the events are in the event log.",
    levels: ["unit", "application"],
  },
  {
    id: "F150.3.3",
    implementation: [
      { file: "native/darwin/src/application_log.m", symbol: "static void storeRecord" },
    ],
    tests: [
      { file: "native/darwin/tests/application_log_test.m", id: "an error is the event native.record.error with where and text" },
      { file: "e2e/input-records.test.mjs", id: "a typed key leaves a record in every layer of the input path" },
    ],
    expected: "The records of the native library are events of the ring of the process with where and text, and a running application stores them in the event log.",
    levels: ["native", "application"],
  },
  {
    id: "F150.3.2",
    implementation: [
      { file: "packages/host/wailsv3/src/event_record.go", symbol: "func emitRecord" },
      { file: "packages/host/tauriv2/src/event_record.rs", symbol: "pub fn emit_record" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/event_record_test.go", id: "TestAnErrorAndAnObservationAreEventsWithWhereAndText" },
      { file: "packages/host/tauriv2/tests/event_record_test.rs", id: "an_error_and_an_observation_are_events_with_where_and_text" },
      { file: "e2e/host-records.test.mjs", id: "the event log holds the run record and the records the page reports" },
      { file: "e2e/page-process.test.mjs", id: "the end of the web content process is written to the event log" },
    ],
    expected: "The records of the host and of the page are events of the event log with where and text, a start buffer holds them until the writer exists, and a running application stores them.",
    levels: ["unit", "application"],
  },
  {
    id: "F150.3.1",
    implementation: [
      { file: "packages/window-check/event-log.mjs", symbol: "export function readEventErrors" },
    ],
    tests: [
      { file: "packages/window-check/test/event-log.test.mjs", id: "readEventErrors returns the events of level error and ignores the other levels" },
      { file: "packages/window-check/test/session-cleanup.test.mjs", id: "an error event of the event log fails the check unless it is declared" },
    ],
    expected: "A window check fails on an error event of the event log of the application unless the check declares it, and names the file of a line that is not an event.",
    levels: ["unit"],
  },
  {
    id: "F150.2.6.2",
    implementation: [
      { file: "packages/host/wailsv3/src/event_log.go", symbol: "func nativeEventOf" },
      { file: "packages/host/wailsv3/src/platform/darwin/events.go", symbol: "PullNativeEvents" },
      { file: "packages/host/tauriv2/src/event_log.rs", symbol: "fn native_event_of" },
      { file: "packages/host/tauriv2/src/platform/darwin/events.rs", symbol: "pub fn pull" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/event_native_test.go", id: "TestARefusedNativeRecordAndTheLossOfTheRingAreCountedAsDropped" },
      { file: "packages/host/wailsv3/tests/event_native_platform_test.go", id: "TestThePlatformPullsAnEmptyNativeRingAsZeroBytesAndNoLoss" },
      { file: "packages/host/tauriv2/tests/event_native_test.rs", id: "a_refused_native_record_and_the_loss_of_the_ring_are_counted_as_dropped" },
      { file: "packages/host/tauriv2/tests/event_native_platform_test.rs", id: "the_platform_pulls_an_empty_native_ring_as_zero_bytes_and_no_loss" },
    ],
    expected: "The writer of each host pulls the native ring through the platform, stores the records in the layer native, and counts the records it refuses and the events the ring refused.",
    levels: ["unit"],
  },
  {
    id: "F150.2.6.1",
    implementation: [
      { file: "native/darwin/src/event_ring.m", symbol: "bool sp_event(" },
    ],
    tests: [
      { file: "native/darwin/tests/event_ring_test.m", id: "a pulled record holds the time, the level, the name and the fields" },
      { file: "native/darwin/tests/event_ring_test.m", id: "each refused event is counted" },
    ],
    expected: "The process ring stores the time, the level, the name and the fields of an event from any thread, returns the records in order, and counts the events it refuses.",
    levels: ["native"],
  },
  {
    id: "F150.2.5",
    implementation: [
      { file: "packages/sok/wailsv3/src/event_log.go", symbol: "func (l *EventLog) rotate" },
      { file: "packages/sok/tauriv2/src/event_log.rs", symbol: "fn rotate" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/event_log_test.go", id: "TestTheEventLogRotatesAtTheBoundAndKeepsEveryGeneration" },
      { file: "packages/host/tauriv2/tests/event_log_test.rs", id: "the_log_rotates_at_the_bound_and_keeps_every_generation" },
    ],
    expected: "A writer closes its file before the line that would pass the bound, keeps every generation under its number, opens the new file with log.open and log.rotated, and continues seq.",
    levels: ["unit"],
  },
  {
    id: "F150.2.4.5",
    implementation: [
      { file: "native/darwin/src/input_inject.m", symbol: "sp_input_result sp_input_key" },
    ],
    tests: [
      { file: "e2e/input-latency.test.mjs", id: "input latency from the injected key to the prompt, trace off and on" },
    ],
    expected: "Every injected Enter is answered by a prompt with the performance trace off, on and off again, and the measured times are reported.",
    levels: ["application"],
  },
  {
    id: "F150.2.4.4",
    implementation: [
      { file: "packages/host/wailsv3/src/event_log.go", symbol: "func StartHostEventLog" },
      { file: "packages/host/tauriv2/src/event_log.rs", symbol: "pub fn start_host" },
    ],
    tests: [
      { file: "e2e/event-log.test.mjs", id: "the host writes its event log from the start of the process" },
      { file: "apps/wailsv3/test/runtime.test.mjs", id: "the log command carries the page batch to the host" },
      { file: "apps/tauriv2/test/runtime.test.mjs", id: "the log command carries the page batch to the host" },
    ],
    expected: "A running application has started the event writer of its host, and the runtime of each application carries the page call log to the host.",
    levels: ["unit", "application"],
  },
  {
    id: "F150.2.4.3",
    implementation: [
      { file: "packages/host/wailsv3/src/event_relay.go", symbol: "func LogCommand" },
      { file: "packages/host/tauriv2/src/event_relay.rs", symbol: "pub fn log_command" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/event_relay_test.go", id: "TestAnInvalidRelayedBatchWritesNothingAndNamesTheEvent" },
      { file: "packages/host/tauriv2/tests/event_relay_test.rs", id: "an_invalid_relayed_batch_writes_nothing_and_names_the_event" },
    ],
    expected: "A batch of page events is validated as a whole before any event is written, and every valid event is stored in the layer page with the time the page gave it.",
    levels: ["unit"],
  },
  {
    id: "F150.2.4.2",
    implementation: [
      { file: "packages/sok/wailsv3/src/event_log.go", symbol: "func (l *EventLog) EmitRelayed" },
      { file: "packages/sok/tauriv2/src/event_log.rs", symbol: "pub fn emit_relayed" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/event_log_test.go", id: "TestARelayedEventKeepsItsLayerAndTimeAndGetsTheSeqOfTheWriter" },
      { file: "packages/host/tauriv2/tests/event_log_test.rs", id: "a_relayed_event_keeps_its_layer_and_time_and_gets_the_seq_of_the_writer" },
    ],
    expected: "A writer stores a relayed event with the layer and the time it carries and the seq of the writer, and refuses a name outside its layer and a layer outside the contract.",
    levels: ["unit"],
  },
  {
    id: "F150.2.4.1",
    implementation: [
      { file: "packages/workbench/log-batch.js", symbol: "export function createEventBatcher" },
    ],
    tests: [
      { file: "packages/workbench/test/log-batch.test.mjs", id: "events emitted in one turn are relayed in one call, in order" },
      { file: "packages/workbench/test/log-batch.test.mjs", id: "a full queue refuses events and the next batch starts with the counted loss" },
    ],
    expected: "The events of one turn travel to the host in one ordered call, a full queue counts the refused events in page.log.dropped, and a failed call is reported with its event count.",
    levels: ["unit"],
  },
  {
    id: "F150.2.2",
    implementation: [
      { file: "packages/sok/tauriv2/src/event_log.rs", symbol: "pub fn emit" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/event_log_test.rs", id: "a_full_queue_returns_false_and_the_writer_records_the_range_as_dropped" },
      { file: "packages/host/tauriv2/tests/event_log_test.rs", id: "the_file_passes_the_audit_of_the_contract_package" },
    ],
    expected: "The Rust writer never blocks a producer, assigns consecutive seq, counts every refused event in log.dropped and writes a file that the audit of the contract accepts.",
    levels: ["unit"],
  },
  {
    id: "F150.2.3",
    implementation: [
      { file: "packages/sok/wailsv3/src/event_log.go", symbol: "func (l *EventLog) Emit" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/event_log_test.go", id: "TestAFullEventQueueReturnsFalseAndTheWriterRecordsTheRangeAsDropped" },
      { file: "packages/host/wailsv3/tests/event_log_test.go", id: "TestTheEventLogPassesTheAuditOfTheContractPackage" },
    ],
    expected: "The Go writer never blocks a producer, assigns consecutive seq, counts every refused event in log.dropped and writes a file that the audit of the contract accepts.",
    levels: ["unit"],
  },
  {
    id: "F150.2.1",
    implementation: [
      { file: "native/darwin/src/event_ring.m", symbol: "bool sp_event_ring_push" },
    ],
    tests: [
      { file: "native/darwin/tests/event_ring_test.m", id: "producers deliver every event once and in order" },
      { file: "native/darwin/tests/event_ring_test.m", id: "a full ring counts the lost events and bytes" },
    ],
    expected: "Many producer threads push events into the ring without a lock, one consumer drains them whole and in order, and a full ring counts the loss.",
    levels: ["native"],
  },
  {
    id: "F150.1",
    implementation: [
      { file: "packages/log-contract/index.js", symbol: "export function auditLog" },
    ],
    tests: [
      { file: "packages/log-contract/test/audit.test.mjs", id: "a log with declared events, consecutive seq and a complete chain passes" },
      { file: "packages/log-contract/test/audit.test.mjs", id: "a declared chain with a missing hop is a finding for its correlation identifier" },
    ],
    expected: "The audit of a log accepts a log that follows the event contract and reports undeclared events, missing fields, unexplained gaps of seq and incomplete chains.",
    levels: ["unit"],
  },
  {
    id: "F160.14",
    implementation: [
      { file: "scripts/audit-run.mjs", symbol: "export function auditRun" },
      { file: "packages/log-contract/index.js", symbol: "export function auditLogs" },
    ],
    tests: [
      { file: "scripts/test/audit-run.test.mjs", id: "an error in the range that the test did not declare is a finding with the file and the line" },
      { file: "scripts/test/audit-run.test.mjs", id: "the logs of every layer under the configuration folders of the marks are audited, and a sidecar error is placed by time" },
      { file: "packages/log-contract/test/audit.test.mjs", id: "seq continues across the rotated generations of one process, and a missing generation is a finding" },
    ],
    expected: "The audit of a run reads the configuration folders from the test marks, audits the event files of every layer and generation, and reports an undeclared error, a gap of seq and an incomplete chain as file, line and message.",
    levels: ["unit"],
  },
  {
    id: "F160.16",
    implementation: [
      { file: "scripts/audit-run.mjs", symbol: "export function auditRun" },
      { file: "packages/window-check/app.mjs", symbol: "  expectEvent(event)" },
    ],
    tests: [
      { file: "scripts/test/audit-run.test.mjs", id: "a test that omits an expected event fails with the missing name at its end mark" },
      { file: "packages/window-check/test/test-marks.test.mjs", id: "expectError and expectEvent append their declaration to marks.jsonl while a run is kept, and only then" },
    ],
    expected: "The audit of a run writes the verdict of each test by the range of its log, and a test that omits a declared event fails with the missing name.",
    levels: ["unit"],
  },
  {
    id: "F160.29.1",
    implementation: [
      { file: ".github/workflows/window-checks.yml", symbol: "node scripts/audit-run.mjs" },
      { file: ".github/workflows/window-checks.yml", symbol: "pnpm verify:windows --when-idle 45" },
    ],
    tests: [
      { file: "scripts/test/workflows.test.mjs", id: "every runner label of a workflow is hosted or declared in examples.md" },
      { file: "scripts/test/workflows.test.mjs", id: "the window-check workflow runs on the declared self-hosted labels" },
      { file: "scripts/test/workflows.test.mjs", id: "the window-check workflow names the window checks, the audit step and the artifact of a failed job" },
    ],
    expected: "The window-check workflow runs on the labels that the operations document declares, runs the window checks, audits the run folder also after a failed check, and keeps the run folder of a failed job.",
    levels: ["unit"],
  },
  {
    id: "F160.30",
    implementation: [
      { file: "packages/sok/wailsv3/src/logged.go", symbol: "func Logged" },
      { file: "packages/sok/wailsv3/src/routine.go", symbol: "func Go" },
      { file: "packages/sok/tauriv2/src/logged.rs", symbol: "pub fn logged" },
      { file: "packages/sok/tauriv2/src/routine.rs", symbol: "pub fn spawn_named" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/event_log_test.go", id: "TestEachCommandIsRecordedWithItsResult" },
      { file: "packages/sok/wailsv3/tests/event_log_test.go", id: "TestAPanicOfACommandIsRecordedWithItsStack" },
      { file: "packages/sok/wailsv3/tests/event_log_test.go", id: "TestAPanicOfARoutineIsRecordedAndEndsTheProcess" },
      { file: "packages/sok/wailsv3/tests/event_log_test.go", id: "TestAFolderThatCannotBeWrittenIsReportedAndTheCommandRuns" },
      { file: "packages/sok/tauriv2/tests/event_log_test.rs", id: "each_command_is_recorded_with_its_result" },
      { file: "packages/sok/tauriv2/tests/event_log_test.rs", id: "a_panic_of_a_command_is_recorded_with_its_stack" },
      { file: "packages/sok/tauriv2/tests/event_log_test.rs", id: "a_panic_of_a_routine_is_recorded_and_ends_the_process" },
      { file: "packages/sok/tauriv2/tests/event_log_test.rs", id: "a_folder_that_cannot_be_written_is_reported_and_the_command_runs" },
      { file: "packages/sok/wailsv3/tests/event_log_fixture_test.go", id: "TestLinesFollowTheGoldenFixtures" },
      { file: "packages/sok/wailsv3/tests/event_log_fixture_test.go", id: "TestFieldsAreEscapedAndAnOversizeEventIsCut" },
      { file: "packages/sok/wailsv3/tests/event_log_fixture_test.go", id: "TestARefusedEventIsCountedAndExplainedByLogDropped" },
      { file: "packages/sok/wailsv3/tests/event_log_fixture_test.go", id: "TestARunStoresOnlyTheEventsThatTheSpecificationNames" },
      { file: "packages/sok/tauriv2/tests/event_log_fixture_test.rs", id: "lines_follow_the_golden_fixtures" },
      { file: "packages/sok/tauriv2/tests/event_log_fixture_test.rs", id: "fields_are_escaped_and_an_oversize_event_is_cut" },
      { file: "packages/sok/tauriv2/tests/event_log_fixture_test.rs", id: "a_refused_event_is_counted_and_explained_by_log_dropped" },
      { file: "packages/sok/tauriv2/tests/event_log_fixture_test.rs", id: "a_run_stores_only_the_events_that_the_specification_names" },
    ],
    expected: "Each run of the command line tool stores the command with its result in its own event file of the targeted configuration directory, and a panic of the command or of a goroutine or thread is stored with its stack and ends the tool with the status 4, in both languages.",
    levels: ["unit"],
  },
  {
    id: "F149.1",
    implementation: [
      { file: "native/darwin/src/input_inject.m", symbol: "static void logPointer" },
    ],
    tests: [
      { file: "e2e/input-records.test.mjs", id: "a typed key leaves a record in every layer of the input path" },
    ],
    expected: "A key typed through the native input of the endpoint leaves a record in every layer of the input path, in time order.",
    levels: ["application"],
  },
  {
    id: "F153",
    implementation: [
      { file: "native/darwin/src/input_inject.m", symbol: "responderName" },
      { file: "native/darwin/src/image_region.m", symbol: "NSApp.isActive ? @\"true\"" },
    ],
    tests: [
      { file: "native/darwin/tests/input_inject_test.m", id: "a key record names the first responder that receives the key" },
      { file: "native/darwin/tests/image_region_test.m", id: "TEST 8: the state records whether the application is active and whether the window is the key window" },
    ],
    expected: "The records of the input path name the first responder, the active state of the application and the key window.",
    levels: ["unit"],
  },
  {
    id: "F145.12",
    implementation: [
      { file: "packages/host/wailsv3/src/endpoint.go", symbol: "endpoint timeout" },
      { file: "packages/host/tauriv2/src/endpoint.rs", symbol: "endpoint timeout" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/endpoint_test.go", id: "TestEndpointRecordsATimeoutOfARequest" },
      { file: "packages/host/tauriv2/tests/endpoint_test.rs", id: "the_endpoint_records_a_timeout_of_a_request" },
    ],
    expected: "Both hosts write the method and the reason of an endpoint request that ends with a timeout.",
    levels: ["unit"],
  },
  {
    id: "F145.13",
    implementation: [
      { file: "packages/host/wailsv3/src/app_update.go", symbol: "StartAppUpdate" },
      { file: "packages/host/tauriv2/src/app_update.rs", symbol: "start_update" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/app_update_test.go", id: "TestTheDetachedUpdateCommandKeepsItsErrorsAndIsRecordedWhenItStarts" },
      { file: "packages/host/tauriv2/tests/app_update_test.rs", id: "the_detached_update_command_keeps_its_errors_and_is_recorded_when_it_starts" },
    ],
    expected: "The detached update command keeps the standard error of the host, and both hosts store host.update.start with the pid and the command line before the final flush.",
    levels: ["unit"],
  },
  {
    id: "F145.14",
    implementation: [
      { file: "packages/host/wailsv3/src/project_removal.go", symbol: "host.project.removal_allowed" },
      { file: "packages/host/tauriv2/src/project_removal.rs", symbol: "host.project.removal_allowed" },
      { file: "packages/host/wailsv3/src/workspace.go", symbol: "host.workspace.settings" },
      { file: "packages/host/tauriv2/src/workspace.rs", symbol: "host.workspace.settings" },
      { file: "packages/host/wailsv3/src/notifications.go", symbol: "host.notification.event" },
      { file: "packages/host/tauriv2/src/notifications.rs", symbol: "host.notification.event" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/project_removal_test.go", id: "TestTheEndOfAWindowRecordsEachRemovalItAllows" },
      { file: "packages/host/tauriv2/tests/project_removal_test.rs", id: "the_end_of_a_window_records_each_removal_it_allows" },
      { file: "packages/host/wailsv3/tests/workspace_test.go", id: "TestEachSettingsChangeIsRecordedWithItsKeys" },
      { file: "packages/host/tauriv2/tests/workspace_test.rs", id: "each_settings_change_is_recorded_with_its_keys" },
      { file: "packages/host/wailsv3/tests/notifications_test.go", id: "TestEachNotificationEventAndFailureIsRecorded" },
      { file: "packages/host/tauriv2/tests/notifications_test.rs", id: "each_notification_event_and_failure_is_recorded" },
    ],
    expected: "Both hosts store an event for each removal that the end of a window allows, each settings change and each event of the notification center, record the failures of the notification center.",
    id: "F145.15",
    implementation: [
      { file: "packages/host/wailsv3/src/performance.go", symbol: "func PerformanceProcessAdd" },
      { file: "packages/host/wailsv3/src/performance.go", symbol: "func PerformanceSurface" },
      { file: "packages/host/tauriv2/src/performance.rs", symbol: "pub fn process_add" },
      { file: "packages/host/tauriv2/src/performance.rs", symbol: "pub fn surface" },
      { file: "packages/workbench/page-log.js", symbol: "export function recordPageStart" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/performance_test.go", id: "TestTheSamplerReadsEveryRegisteredProcess" },
      { file: "packages/host/wailsv3/tests/performance_test.go", id: "TestSurfaceLifecycleEventsHoldTheGeometry" },
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestTheSamplerNamesARunningSidecarUntilItEnds" },
      { file: "packages/host/tauriv2/tests/performance_test.rs", id: "the_sampler_reads_every_registered_process" },
      { file: "packages/host/tauriv2/tests/performance_test.rs", id: "surface_lifecycle_events_hold_the_geometry" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "the_sampler_names_a_running_sidecar_until_it_ends" },
      { file: "packages/workbench/test/page-log.test.mjs", id: "the start of a page is the event page.start with the origin of the document clock and its address" },
    ],
    expected: "The sampler of both hosts reads the host and every registered sidecar process, the surface lifecycle of the trace holds the geometry, and a document of the main page marks its start.",
    levels: ["unit"],
  },
  {
    id: "F145.18",
    implementation: [
      { file: "scripts/check-failure-table.mjs", symbol: "export function recordsMissingFromTable" },
    ],
    tests: [
      { file: "scripts/test/check-failure-table.test.mjs", id: "every error record that a host or the native library writes at a literal place is in the failure table of the diagnostics" },
    ],
    expected: "Every error record that a host or the native library writes at a literal place is a row of the failure table of the diagnostics in both languages.",
    levels: ["unit"],
  },
  {
    id: "F152",
    implementation: [
      { file: "packages/plugin-api/sidecar-port.js", symbol: "orderedSidecar requires a failure handler" },
      { file: "packages/workbench/host.js", symbol: "send failed:" },
    ],
    tests: [
      { file: "packages/workbench/test/window-sidecar-send.test.mjs", id: "a send after a failed send to the same sidecar is delivered and the failure is reported" },
      { file: "packages/plugin-api/test/sidecar-port.test.mjs", id: "a port without a failure handler is refused at the boundary" },
    ],
    expected: "A failed send of the main page to a sidecar is reported and the sends after it are delivered.",
    levels: ["unit"],
  },
  {
    id: "F145.11",
    implementation: [
      { file: "packages/host/wailsv3/src/application_log.go", symbol: "func TranscriptEntry" },
      { file: "packages/host/tauriv2/src/application_log.rs", symbol: "pub fn transcript_entry" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/application_log_test.go", id: "TestTranscriptLinesReachTheApplicationLog" },
      { file: "packages/host/tauriv2/tests/application_log_test.rs", id: "transcript_lines_reach_the_application_log" },
    ],
    expected: "Both hosts write the lines of the diagnostic transcript of a window to the application log.",
    levels: ["unit"],
  },
  {
    id: "F145.10.2",
    implementation: [
      { file: "native/darwin/src/webview_geometry.m", symbol: "void sp_webview_log_process_end" },
      { file: "packages/host/wailsv3/src/platform/darwin/webview.m", symbol: "webViewWebContentProcessDidTerminate" },
    ],
    tests: [
      { file: "native/darwin/tests/webview_process_test.m", id: "the end of the WebContent process is recorded with the address" },
    ],
    expected: "The end of the WebContent process of a native web view is recorded with its address.",
    levels: ["unit"],
  },
  {
    id: "F145.10.1",
    implementation: [
      { file: "native/darwin/src/document_view.m", symbol: "webViewWebContentProcessDidTerminate" },
    ],
    tests: [
      { file: "native/darwin/tests/document_view_test.m", id: "a failed navigation is recorded with its address" },
    ],
    expected: "The native library records the failures and refusals of a document view and the end of its WebContent process.",
    levels: ["unit"],
  },
  {
    id: "F145.9",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "func (c *Sidecars) dropMessage" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: "fn drop_message" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestClosedSurfaceMessagesAreDiscardedAndUnknownOnesFail" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "a_dropped_sidecar_message_is_recorded" },
      { file: "packages/host/wailsv3/tests/flush_test.go", id: "TestEveryPendingReplyIsFlushedAfterTheQueueDrains" },
      { file: "packages/host/tauriv2/tests/flush_test.rs", id: "a_buffered_close_is_recorded" },
    ],
    expected: "Both hosts record a sidecar message that no window owns and a closed notice that waits for a full queue.",
    levels: ["unit"],
  },
  {
    id: "F145.8",
    implementation: [
      { file: "packages/host/wailsv3/src/images.go", symbol: "func logRefusedFrame" },
      { file: "packages/host/tauriv2/src/images.rs", symbol: "fn log_refused_frame" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/images_test.go", id: "TestImageFrameRefusalsAreRecorded" },
      { file: "packages/host/tauriv2/tests/images_test.rs", id: "image_frame_refusals_are_recorded" },
    ],
    expected: "Both hosts record each refused frame of an image region and each image field that is not an envelope.",
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
      { file: "native/darwin/src/image_region.m", symbol: "native.input.report" },
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
    id: "F102",
    implementation: [
      { file: "packages/workbench/contributions.js", symbol: "export function contributionsOf" },
    ],
    tests: [
      { file: "e2e/extension-points.test.mjs", id: "a contributed item connects to the extension point of its provider and the provider uses it" },
    ],
    expected: "A provider plugin declares an extension point, a contributor plugin installed with it contributes an item, and the provider page imports the item and uses it in a running application.",
    levels: ["application"],
  },
  {
    id: "F143",
    implementation: [
      { file: "native/darwin/src/image_region.m", symbol: "selectedSourceComposesOnlyHangul] && through > self.committedLength" },
    ],
    tests: [
      { file: "native/darwin/tests/image_region_hangul_test.m", id: "the committed text is 하나 and the space, each once and in order" },
      { file: "native/darwin/tests/image_region_hangul_test.m", id: "the syllable two before the newest insert is committed" },
    ],
    expected: "While a source that composes only Hangul is selected, the image region keeps the syllable before the newest insert revisable, so a revision of it after a later append commits each syllable once and in order.",
    levels: ["unit"],
  },
  {
    id: "F161.45",
    implementation: [
      { file: "packages/workbench/settings-ui.js", symbol: "settings scroll position is not a number" },
    ],
    tests: [
      { file: "packages/workbench/test/settings-scroll.test.mjs", id: "a negative scroll position of the settings modal is kept as reported and a value that is not a number is refused" },
    ],
    expected: "The settings modal keeps a negative scroll position that the native modal reports and refuses a value that is not a number.",
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
    id: "F104",
    implementation: [
      { file: "scripts/check-comment-language.mjs", symbol: "export function findKoreanComments" },
    ],
    tests: [
      { file: "scripts/test/comment-language.test.mjs", id: "no tracked source file of the repository holds a Hangul comment" },
      { file: "scripts/test/comment-language.test.mjs", id: "a regular expression literal with a quote does not hide the comments after it" },
    ],
    expected: "Every comment of the tracked source files is English, and the repository test of pnpm test reports each comment line that holds Hangul.",
    levels: ["unit"],
  },
  {
    id: "F140",
    implementation: [
      { file: "packages/workbench/file-open.js", symbol: "export function chooseOpener" },
    ],
    tests: [
      { file: "e2e/files.test.mjs", id: "the failure to open a file is shown in the message row of the file tree and not in the error display" },
    ],
    expected: "The failure of core.file.open for a file that no plugin opens is shown in the message row of the file tree of the files plugin and not in the error display of the main document.",
    levels: ["application"],
  },
  {
    id: "F107",
    implementation: [
      { file: "packages/plugin-api/index.js", symbol: "export function validateSidebars" },
    ],
    tests: [
      { file: "packages/workbench/test/settings-removed-plugin.test.mjs", id: "a stored link to the set of a plugin that was removed is kept and the settings load" },
      { file: "packages/workbench/test/settings-removed-plugin.test.mjs", id: "a stored link of a loaded plugin to a missing set still fails the settings load" },
      { file: "packages/plugin-api/test/sidebar-defaults.test.mjs", id: "a link of a plugin that is not loaded keeps its set and a link of a loaded plugin needs a known set" },
    ],
    expected: "A stored link to the set of a plugin that is no longer loaded is kept and the settings load, and a link of a loaded plugin to a missing set fails.",
    levels: ["unit"],
  },
  {
    id: "F151",
    implementation: [
      { file: "packages/workbench/debug-ui.js", symbol: "export async function showDebugState" },
      { file: "packages/workbench/debug-timeline.js", symbol: "export function queryOf" },
      { file: "packages/sok/wailsv3/src/debug.go", symbol: "func runDebug" },
      { file: "packages/sok/tauriv2/src/debug.rs", symbol: "pub(crate) fn run_debug" },
    ],
    tests: [
      { file: "packages/workbench/test/debug-timeline.test.mjs", id: "the text line of each golden page is the line that the implementations of sok print" },
      { file: "packages/workbench/test/debug-state.test.mjs", id: "a comparison lists the paths whose values differ, including paths present in one file" },
      { file: "packages/sok/wailsv3/tests/debug_test.go", id: "TestQueryPrintsTheGoldenLinesOfEveryCase" },
      { file: "packages/sok/tauriv2/tests/debug_test.rs", id: "query_prints_the_golden_lines_of_every_case" },
    ],
    expected: "The debug view shows the event files as a filtered, followed and saved timeline and the state files as a tree, and the command line prints the same timeline rows.",
    levels: ["unit"],
  },
  {
    id: "R5.4",
    implementation: [
      { file: "packages/sok/wailsv3/src/plugins.go", symbol: "func InstalledName" },
      { file: "packages/sok/tauriv2/src/plugins.rs", symbol: "pub fn installed_name" },
      { file: "packages/sok/wailsv3/src/install.go", symbol: "func ValidateInstalled" },
      { file: "packages/sok/tauriv2/src/install.rs", symbol: "pub fn validate_installed" },
      { file: "packages/host/wailsv3/src/installed.go", symbol: "func enabledPlugins" },
      { file: "packages/host/tauriv2/src/installed.rs", symbol: "fn enabled_plugins" },
      { file: "packages/workbench/stage.mjs", symbol: "function enabledInstalledPlugins" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/plugins_test.go", id: "TestPluginDependentsReadTheNameFromThePackageJSONOfTheInstalledPlugin" },
      { file: "packages/sok/wailsv3/tests/plugins_test.go", id: "TestReadInstalledRefusesAPackageField" },
      { file: "packages/sok/tauriv2/tests/plugins_test.rs", id: "plugin_dependents_read_the_name_from_the_package_json_of_the_installed_plugin" },
      { file: "packages/sok/tauriv2/tests/plugins_test.rs", id: "read_installed_refuses_a_package_field" },
      { file: "packages/host/wailsv3/tests/installed_test.go", id: "TestInstalledPluginsDocumentReadsTheNameFromThePackageJSON" },
      { file: "packages/host/wailsv3/tests/installed_test.go", id: "TestInstalledPluginsDocumentRefusesAPackageField" },
      { file: "packages/host/tauriv2/tests/installed_test.rs", id: "installed_plugins_document_reads_the_name_from_the_package_json" },
      { file: "packages/host/tauriv2/tests/installed_test.rs", id: "installed_plugins_document_refuses_a_package_field" },
      { file: "packages/workbench/test/stage.test.mjs", id: "staging refuses an installed.json entry that holds package" },
    ],
    expected: "installed.json holds no package; the hosts, sok and the staging read the name of an installed plugin from its package.json and refuse an installed.json that holds package with an error that names the file and the field.",
    levels: ["unit"],
  },
  {
    id: "F156",
    implementation: [
      { file: "packages/workbench/debug-ui.js", symbol: "export async function viewDebugFile" },
    ],
    tests: [
      { file: "packages/workbench/test/debug-image-ui.test.mjs", id: "the modal is placed again with the height of the card when the image has loaded" },
      { file: "e2e/modal.test.mjs", id: "Help > Debug records the state, lists the logs folder and refuses a path outside it" },
    ],
    expected: "The native modal of the debug view has the height of the card with the loaded image.",
    levels: ["unit", "application"],
  },
  {
    id: "F111",
    implementation: [{ file: "packages/plugin-api/document-region.js", symbol: "export function attachRegion" }],
    tests: [{ file: "packages/plugin-api/test/document-region.test.mjs", id: "a document handle posts messages and receives the messages of its own document" }],
    expected: "A plugin document shows in a document region of its surface and exchanges messages with its page.",
    levels: ["unit"],
  },
  {
    id: "F112",
    implementation: [
      { file: "packages/host/wailsv3/src/deep_link.go", symbol: "func ParseDeepLink" },
      { file: "packages/host/tauriv2/src/deep_link.rs", symbol: "pub fn parse_deep_link" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/deep_link_test.go", id: "TestDeepLinkParseAcceptsCoreAndPluginOwners" },
      { file: "packages/host/tauriv2/tests/deep_link_test.rs", id: "deep_link_parse_accepts_core_and_plugin_owners" },
    ],
    expected: "A deep link soksak://<owner>/<command>?<params> parses to the declared command of its owner in both hosts, and a refused link names its reason.",
    levels: ["unit"],
  },
  {
    id: "F172",
    implementation: [
      { file: "packages/host/wailsv3/src/deep_link.go", symbol: "func (q *DeepLinkQueue) Ready" },
      { file: "packages/host/tauriv2/src/deep_link.rs", symbol: "pub fn ready(&self" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/deep_link_test.go", id: "TestDeepLinkQueueRunsKeptLinksInOrderWhenWindowIsReady" },
      { file: "packages/host/tauriv2/tests/deep_link_test.rs", id: "deep_link_queue_runs_kept_links_in_order_when_window_is_ready" },
    ],
    expected: "A deep link that arrives before the first window is ready runs in arrival order when the window becomes ready, and a link that arrives later runs at once.",
    levels: ["unit"],
  },
  {
    id: "F123",
    implementation: [{ file: "packages/host/wailsv3/src/surfaces.go", symbol: "func FrameAnswerEvent" }],
    tests: [
      { file: "packages/host/wailsv3/tests/images_test.go", id: "TestFrameAnswerEventRecordsConsumedAndRefusedAnswers" },
      { file: "packages/host/tauriv2/tests/images_test.rs", id: "frame_answer_event_records_consumed_and_refused_answers" },
    ],
    expected: "Every answer to a frame is a trace event, so a terminal that holds typed text is located by the records; the terminal plugin sends its queued input when a session reattaches.",
    levels: ["unit"],
  },
  {
    id: "F141",
    implementation: [{ file: "packages/sok/wailsv3/src/install.go", symbol: "func ValidateRegistryPlugin" }],
    tests: [{ file: "scripts/test/registry-manifests.test.mjs", id: "each plugin version that the new core installs and whose manifest it rejects is reported" }],
    expected: "The hwp plugin is listed in the registry with the files sidecar it requires.",
    levels: ["unit"],
  },
  {
    id: "F124",
    implementation: [{ file: "packages/workbench/core-exposure.js", symbol: 'registry.command("core.debug.save"' }],
    tests: [{ file: "packages/host/tauriv2/tests/debug_test.rs", id: "debug_copy_copies_a_file_of_the_logs_folder_only" }],
    expected: "Every 0.0.x release is a diagnostic build, and the debug view lists and saves every diagnostic file.",
    levels: ["unit"],
  },
  {
    id: "F162",
    implementation: [{ file: "packages/workbench/core-exposure.js", symbol: 'registry.command("core.file.place"' }],
    tests: [
      { file: "packages/host/wailsv3/tests/file_place_test.go", id: "TestAPlaceInsideTheProjectIsAnsweredRelativeToTheRoot" },
      { file: "packages/host/tauriv2/tests/file_place_test.rs", id: "a_place_inside_the_project_is_answered_relative_to_the_root" },
    ],
    expected: "A blank document opens from the new-tab control and its first save asks for the file inside the project.",
    levels: ["unit"],
  },
  {
    id: "F135",
    implementation: [{ file: "native/darwin/src/document_view.h", symbol: "sp_document_load" }],
    tests: [{ file: "native/darwin/tests/document_typing_test.m", id: "the region loads the page" }],
    expected: "The difference between an inactive plain window and the hosts that take typed text in a document region is explained in the specification.",
    levels: ["unit"],
  },
  {
    id: "F160.24",
    implementation: [{ file: "packages/sok/wailsv3/src/log_query.go", symbol: "func ParseLogQuery" }],
    tests: [{ file: "packages/sok/wailsv3/tests/debug_test.go", id: "TestQueryPrintsTheGoldenLinesOfEveryCase" }],
    expected: "One query that the host answers searches the logs.",
    levels: ["unit"],
  },
  {
    id: "F149",
    implementation: [{ file: "packages/log-contract/index.js", symbol: "export function auditLog" }],
    tests: [{ file: "e2e/activation/ime.test.mjs", id: "a Korean syllable typed right after an input-source switch reaches the PTY once" }],
    expected: "Typed English text and a composed Korean syllable pass through every layer of a running application and reach the PTY once.",
    levels: ["application"],
  },
  {
    id: "F150",
    implementation: [{ file: "packages/log-contract/index.js", symbol: "export function auditLog" }],
    tests: [{ file: "packages/log-contract/test/audit.test.mjs", id: "a log with declared events, consecutive seq and a complete chain passes" }],
    expected: "Every layer writes its records as events of one contract that the audit checks.",
    levels: ["unit"],
  },
  {
    id: "F154",
    implementation: [{ file: "scripts/node-tests.mjs", symbol: "export function discoverNodeTests" }],
    tests: [{ file: "scripts/test/node-tests.test.mjs", id: "each test file of a package is a test with the folder and the flags of its package" }],
    expected: "Every long test suite runs as separate tests that report what runs, how long it has run and its result.",
    levels: ["unit"],
  },
  {
    id: "F158",
    implementation: [{ file: "packages/workbench/debug-timeline.js", symbol: "export const HOLD_LIMIT" }],
    tests: [{ file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "the view holds at most 2000 rows and refuses an older page beyond them with an error" }],
    expected: "The debug view holds a bounded number of rows, so a large log does not stop the page.",
    levels: ["unit"],
  },
  {
    id: "F159",
    implementation: [{ file: "packages/workbench/debug-ui.js", symbol: "export async function viewDebugFile" }],
    tests: [{ file: "packages/workbench/test/debug-image-ui.test.mjs", id: "the modal is placed again with the height of the card when the image has loaded" }],
    expected: "The native modal of an image in the debug view has the height of the card with the loaded image.",
    levels: ["unit"],
  },
  {
    id: "F160.28",
    implementation: [{ file: "packages/log-contract/index.js", symbol: "export function auditLog" }],
    tests: [{ file: "packages/log-contract/test/audit.test.mjs", id: "a line without mono_ns, or with a mono_ns that is not a positive integer, is a finding" }],
    expected: "Every line of every layer carries the real time and a monotonic clock, and a line without them is a finding of the audit.",
    levels: ["unit"],
  },
  {
    id: "F160.32",
    implementation: [
      { file: "packages/plugin-api/plugin-runtime.js", symbol: "export function createPluginRuntime" },
      { file: "packages/workbench/plugin-records.js", symbol: "export const pluginRecords" },
    ],
    tests: [
      { file: "packages/plugin-api/test/surface.test.mjs", id: "a plugin event carries the cids of its chain to the page writer" },
      { file: "packages/workbench/test/plugin-records.test.mjs", id: "an event of a plugin leaves with its cids and its builder runs while the level is stored" },
    ],
    expected: "The plugin runtime gives plugins what they need to record by the contract.",
    levels: ["unit"],
  },
  {
    id: "F160.33",
    implementation: [{ file: "scripts/audit-run.mjs", symbol: "export function auditRun" }],
    tests: [{ file: "scripts/test/audit-run.test.mjs", id: "the events of a sidecar installed in a configuration folder of the run are audited against its catalog" }],
    expected: "The events of a sidecar in the configuration folder of a run are audited against its catalog.",
    levels: ["unit"],
  },
  {
    id: "F166",
    implementation: [{ file: "packages/host/wailsv3/src/log_policy.go", symbol: "func watchPolicyFile" }],
    tests: [{ file: "packages/host/wailsv3/tests/log_policy_test.go", id: "TestThePolicyFileIsWatchedAndEveryChangeIsAppliedOnce" }],
    expected: "A function that a maintained library provides uses that library, and code of its own states which requirement the libraries do not meet.",
    levels: ["unit"],
  },
  {
    id: "F187",
    implementation: [{ file: "packages/host/wailsv3/tests/event_channels_test.go", symbol: "func TestALossNamesTheChannelOfTheRefusedEvents" }],
    tests: [
      { file: "packages/host/wailsv3/tests/event_channels_test.go", id: "TestALossNamesTheChannelOfTheRefusedEvents" },
      { file: "packages/host/tauriv2/tests/event_channels_test.rs", id: "a_loss_names_the_channel_of_the_refused_events" },
    ],
    expected: "The loss tests of both hosts add events until both channels are refused, and every contract comment is above its test.",
    levels: ["unit"],
  },
  {
    id: "F182",
    implementation: [{ file: "e2e/input-records.test.mjs", symbol: "e.page === hops.pageCall.page" }],
    tests: [{ file: "e2e/input-records.test.mjs", id: "a typed key leaves a record in every layer of the input path" }],
    expected: "The input records check takes the clock anchor of the page that wrote page.call.",
    levels: ["application"],
  },
  {
    id: "F192",
    implementation: [{ file: "packages/workbench/plane.js", symbol: "function syncBackgroundSessions" }],
    tests: [{ file: "packages/workbench/test/background-sessions.test.mjs", id: "a background session opens only for a tab without a mounted surface and ends when its surface mounts" }],
    expected: "A background session exists only for a tab whose surface is not mounted, and each of its decisions is an event.",
    levels: ["unit"],
  },
  {
    id: "F197",
    implementation: [{ file: "packages/workbench/settings.js", symbol: "export const debugOn" }],
    tests: [{ file: "packages/workbench/test/settings-debug-switch.test.mjs", id: "the debug switch runs core.settings.debug and is on only when the trace and every class are at trace" }],
    expected: "Diagnostics are off by default and the debug switch turns the trace and every log class on and off together.",
    levels: ["unit"],
  },
  {
    id: "F199",
    implementation: [
      { file: "packages/workbench/tab-session.js", symbol: "export function createTabSessions" },
      { file: "packages/host/wailsv3/src/workspace.go", symbol: "func putTabSession" },
      { file: "packages/host/tauriv2/src/workspace.rs", symbol: "fn put_tab_session" },
    ],
    tests: [
      { file: "packages/workbench/test/tab-session.test.mjs", id: "a session stored before a restart is passed to the first attach after it and to the attach after a restore" },
      { file: "packages/host/wailsv3/tests/workspace_test.go", id: "TestTabSessionPutRewritesOnlyItsOwnFile" },
      { file: "packages/host/tauriv2/tests/workspace_test.rs", id: "tab_session_put_rewrites_only_its_own_file" },
    ],
    expected: "A browser tab keeps the session history of its document regions across a restart in tab-sessions/<tab>.json.",
    levels: ["unit"],
  },
  {
    id: "F193",
    implementation: [
      { file: "packages/host/wailsv3/src/sidecars.go", symbol: "\"--service-dir\", serviceDir, \"--log-dir\"" },
      { file: "packages/host/tauriv2/src/sidecars.rs", symbol: ".arg(\"--service-dir\")" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/sidecars_test.go", id: "TestSidecarReceivesTheLogDirectory" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "a_sidecar_receives_the_log_directory" },
    ],
    expected: "A sidecar service starts with the arguments that the parser of its release accepts.",
    levels: ["unit"],
  },
  {
    id: "F196",
    implementation: [{ file: "packages/plugin-api/document-region.js", symbol: "subscribe(stream, listener)" }],
    tests: [{ file: "packages/plugin-api/test/document-region.test.mjs", id: "a stream subscription receives the messages of its handle and close ends it" }],
    expected: "A document region sends its elements and requests only through a subscribed stream.",
    levels: ["unit"],
  },
  {
    id: "F200",
    implementation: [{ file: "scripts/measure-host-calls.mjs", symbol: "export async function measure" }],
    tests: [{ file: "scripts/test/measure-host-calls.test.mjs", id: "the idle mode waits instead of sending calls and reports the growth per minute" }],
    expected: "The page garbage of host calls, idle time and host events is measured in both hosts.",
    levels: ["unit"],
  },
  {
    id: "F204",
    implementation: [{ file: "packages/host/wailsv3/go.mod", symbol: "replace github.com/wailsapp/wails/v3 => github.com/min-0-max/wails/v3" }],
    tests: [{ file: "packages/host/wailsv3/tests/application_log_test.go", id: "TestTheTransportReturnsAFailedCallWithoutLoggingIt" }],
    expected: "The Wails host builds against the fork under its renamed account.",
    levels: ["unit"],
  },
  {
    id: "F252-1",
    implementation: [
      { file: "packages/plugin-api/index.js", symbol: "export function exposureEntries" },
      { file: "packages/plugin-api/index.js", symbol: "export async function replyPayload" },
      { file: "packages/workbench/exposure.js", symbol: "async function follow(key, name, watch)" },
      { file: "packages/workbench/surface-modules.js", symbol: "view call ${event.id} reply" },
      { file: "packages/workbench/plugin-host.js", symbol: "export function checkHostSidecarRequest" },
      { file: "packages/workbench/page-log.js", symbol: "function consoleText" },
      { file: "scripts/test-command.mjs", symbol: "export function combineFailures" },
      { file: "scripts/test-discovery.mjs", symbol: "export function cargoTestExecutables" },
      { file: "scripts/test-runner.mjs", symbol: "export async function runTests" },
      { file: "scripts/language-test-adapters.mjs", symbol: "export const SUPPORTED_LANGUAGES" },
      { file: "scripts/check-app-update.mjs", symbol: "export function endpointOf" },
    ],
    tests: [
      { file: "packages/plugin-api/test/exposure.test.mjs", id: "a dom request refuses an index that is not a non-negative integer instead of reading it as the first element" },
      { file: "packages/plugin-api/test/exposure.test.mjs", id: "an undefined status value or command result is refused with an error that names it, and null is the no-value" },
      { file: "packages/workbench/test/surface-view.test.mjs", id: "a view reply the host refuses is reported through the page error path" },
      { file: "packages/workbench/test/exposure.test.mjs", id: "a status watch that fails for a reason other than the closed surface reports the error" },
      { file: "packages/workbench/test/exposure.test.mjs", id: "a plugin host status reply without seq and value is refused instead of read as an empty value" },
      { file: "packages/workbench/test/plugin-host-operations.test.mjs", id: "a body that is not an object or has no string operation field is refused" },
      { file: "packages/workbench/test/plugin-host-calls.test.mjs", id: "a host reply that arrives after its layer left is reported, not dropped" },
      { file: "packages/workbench/test/plugin-operations.test.mjs", id: "a host call that rejects with a value that is not an Error is reported with its text" },
      { file: "packages/workbench/test/page-log.test.mjs", id: "a console argument that JSON cannot serialize is recorded as a marker with its reason, not as [object Object]" },
      { file: "scripts/test/test-command.test.mjs", id: "keeps a process error and a cleanup error together when both occur" },
      { file: "scripts/test/test-discovery.test.mjs", id: "a cargo line that starts with a brace but is not JSON fails with the line" },
      { file: "scripts/test/test-runner.test.mjs", id: "a limit above ten minutes, a missing limit and an empty list are refused" },
      { file: "scripts/test/test-language-test-adapters.test.mjs", id: "refuses a case without its own limit and names the case" },
      { file: "scripts/test/check-app-update.test.mjs", id: "the endpoint file is absent until written, and a file that is not JSON is an error that names the path" },
    ],
    expected: "Each failure of the audited JavaScript paths is reported or refused with its cause, and each case or test declares its own limit.",
    levels: ["unit"],
  },
  {
    id: "F207",
    implementation: [{ file: "scripts/language-test-adapters.mjs", symbol: "export const SUPPORTED_LANGUAGES" }],
    tests: [{ file: "scripts/test/test-language-test-adapters.test.mjs", id: "discovers all supported language cases, each with its own explicit limit" }],
    expected: "Each language case declares its own limit, and a case without one is refused.",
    levels: ["unit"],
  },
  {
    id: "F213",
    implementation: [{ file: "scripts/push-range.mjs", symbol: "export function pushRanges" }],
    tests: [{ file: "scripts/test/push-range.test.mjs", id: "a new branch without upstream resolves the commits that origin/main does not have" }],
    expected: "The pre-push hook sends the commits of each pushed ref, and a branch without an upstream resolves them against origin/main.",
    levels: ["unit"],
  },
  {
    id: "F214",
    implementation: [{ file: "scripts/check-comment-language.mjs", symbol: "export function findKoreanComments" }],
    tests: [{ file: "scripts/test/comment-language.test.mjs", id: "hook files and extensionless scripts are checked, and other extensionless files are not" }],
    expected: "The comment language check reads the hook folder and the extensionless scripts, so a Korean comment in them is reported.",
    levels: ["unit"],
  },
  {
    id: "F218",
    implementation: [
      { file: "packages/host/tauriv2/src/routine/routine.rs", symbol: "pub fn record_panic(" },
      { file: "packages/host/tauriv2/src/buttons.rs", symbol: "pub fn report(&self, mask: u64)" },
      { file: "packages/host/wailsv3/src/event_record.go", symbol: "func recordPanic(name, text, stack string)" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/panic_hook_test.rs", id: "a_panic_before_the_writer_exists_is_stored_when_the_writer_opens" },
      { file: "packages/host/tauriv2/tests/panic_hook_test.rs", id: "a_panic_that_no_writer_stores_is_written_to_the_standard_error_in_full" },
      { file: "packages/host/tauriv2/tests/buttons_test.rs", id: "a_poisoned_button_state_is_recovered_and_the_next_report_is_announced" },
      { file: "packages/host/wailsv3/tests/routine_test.go", id: "TestAPanicBeforeTheWriterExistsIsRecordedWhenTheWriterOpens" },
      { file: "packages/host/wailsv3/tests/routine_test.go", id: "TestAPanicThatNoWriterStoresIsWrittenToTheStandardErrorInFull" },
    ],
    expected: "A panic before the writer exists is stored when the writer opens, a panic that no writer stores is written to the standard error in full, and a poisoned button state is recovered by the next report.",
    levels: ["unit"],
  },
  {
    id: "F221",
    implementation: [{ file: "scripts/generate-event-classes.mjs", symbol: "run" }],
    tests: [{ file: "scripts/test/event-classes.test.mjs", id: "the committed class tables equal what the catalog gives" }],
    expected: "The generated event class tables of sok and of the workbench equal the catalog, and the push gate runs the test.",
    levels: ["unit"],
  },
  {
    id: "F222",
    implementation: [{ file: ".githooks/pre-push", symbol: "push-check" }],
    tests: [{ file: "scripts/test/workflows.test.mjs", id: "the push check runs every check of the structure step and the format and clippy checks of ci" }],
    expected: "The pre-push hook runs make -C with the form the workflow test requires, with the range of the pushed refs.",
    levels: ["unit"],
  },
  {
    id: "F220",
    implementation: [{ file: "scripts/check-host-contract.mjs", symbol: "auditDeclarations" }],
    tests: [{ file: "scripts/test/check-host-contract.test.mjs", id: "the static audit fails a marker that names an undefined case, a case outside its scope, or no case, without running tests" }],
    expected: "The static host contract check fails a test marker that names an undefined case, a case outside its host scope, or no case, and a case in a host scope that no test declares; push-check runs it.",
    levels: ["unit"],
  },
  {
    id: "F224",
    implementation: [{ file: "packages/plugin-api/records-check.js", symbol: "declaredFiles" }],
    tests: [{ file: "packages/plugin-api/test/records-check.test.mjs", id: "a file the census declaration excludes is not a record of the repository" }],
    expected: "The record check applies the census exclude of the checked repository, so a committed generated bundle is not read as a record.",
    levels: ["unit"],
  },
  {
    id: "F227",
    implementation: [{ file: "packages/workbench/view-calls.js", symbol: "tab.state.read" }],
    tests: [
      { file: "packages/workbench/test/view-calls.test.mjs", id: "a forwarded tab.state.read returns the tab state of its surface" },
      { file: "packages/workbench/test/view-calls.test.mjs", id: "tab.state.write stores the params as the tab state of its surface" },
    ],
    expected: "A view reads and writes the tab state of its surface through tab.state of the surface context.",
    levels: ["unit"],
  },
  {
    id: "F225",
    implementation: [{ file: "packages/plugin-api/exposure-check.js", symbol: "checkPluginRepository" }],
    tests: [
      { file: "packages/plugin-api/test/exposure-check.test.mjs", id: "a plugin repository whose sources match its declarations passes" },
    ],
    expected: "The exposure check reads a manifest whose sections are status-form sections, which carry no module source, so a manifest with a status section is checked instead of crashing.",
    levels: ["unit"],
  },
  {
    id: "F226",
    implementation: [{ file: "packages/workbench/sidebar-sections.js", symbol: "mountDeclared" }],
    tests: [{ file: "packages/workbench/test/sidebar-sections.test.mjs", id: "a declared section draws the value of its source, shows its rejection, and reports mounted, error, text and controls" }],
    expected: "The workbench uses the declared full status name of a section for the registry and the display, so a declared section of a view matches its registration and draws.",
    levels: ["unit"],
  },
  {
    id: "F251",
    implementation: [
      { file: "packages/workbench/view-calls.js", symbol: "statusNameOf" },
      { file: "packages/workbench/view-events.js", symbol: "statusWatch" },
      { file: "packages/plugin-api/view.js", symbol: "watchStatus" },
    ],
    tests: [
      { file: "packages/workbench/test/view-calls.test.mjs", id: "runtime.status.watch subscribes a core status or a status of the plugin and runtime.status.unwatch ends it" },
      { file: "packages/workbench/test/view-calls.test.mjs", id: "runtime.status.watch and runtime.status.unwatch refuse a status of another plugin and a name that is not text, and subscribe to nothing" },
      { file: "packages/workbench/test/view-events.test.mjs", id: "a status watch pushes each value of its name as the status event and ends at unwatch" },
      { file: "packages/workbench/test/view-events.test.mjs", id: "a status watch that the page refuses registers nothing and rejects with the refusal" },
      { file: "packages/workbench/test/surface-view.test.mjs", id: "a view watch of a status that the exposure does not declare is refused with its name" },
      { file: "packages/plugin-api/test/view-status-contract.test.mjs", id: "view status contract publishes the required cases in order" },
      { file: "packages/host/wailsv3/src/surfaces_test.go", id: "TestViewStatusWatchIsForwardedAndStatusValueIsPosted" },
      { file: "packages/host/tauriv2/tests/documents_test.rs", id: "view_status_watch_is_forwarded_and_a_status_value_is_posted" },
    ],
    expected: "A view watches a core status or a status of its plugin with runtime.status.watch and runtime.status.unwatch, receives each value as the view event status, and a name with another owner or an undeclared plugin status is refused and runs nothing; both hosts relay the calls and the event unchanged.",
    levels: ["unit"],
  },
  {
    id: "F241",
    implementation: [{ file: "packages/workbench/view-calls.js", symbol: "case \"runtime.clipboard.persistPNG\"" }],
    tests: [
      { file: "packages/workbench/test/view-calls.test.mjs", id: "runtime.clipboard.read returns the typed png payload with base64 data, or null when the clipboard holds none" },
      { file: "packages/workbench/test/view-calls.test.mjs", id: "runtime.clipboard.persistPNG persists the base64 payload and returns the shell path" },
    ],
    expected: "The view call runtime.clipboard.read with png returns the typed payload with base64 data or null, and runtime.clipboard.persistPNG persists the base64 payload through the clipboard bridge of the surface context.",
    levels: ["unit"],
  },
  {
    id: "F242",
    implementation: [{ file: "packages/workbench/view-calls.js", symbol: "fields.cids === undefined ? undefined : { cids: fields.cids }" }],
    tests: [
      { file: "packages/workbench/test/view-calls.test.mjs", id: "runtime.log passes the cids of the record to the writer of the page" },
      { file: "packages/plugin-api/test/surface.test.mjs", id: "a plugin event carries the cids of its chain to the page writer" },
    ],
    expected: "The view call runtime.log passes cids to the log of the surface context, which validates them as the page log path does.",
    levels: ["unit"],
  },
  {
    id: "F239",
    implementation: [{ file: "scripts/rust-tests.mjs", symbol: "testNames" }],
    tests: [{ file: "scripts/test/rust-repeat.test.mjs", id: "make rust-repeat names each test when it starts, reports its result and elapsed time, and kills a test at its limit" }],
    expected: "Each test runner names every test when it starts, reports its result and elapsed time, and ends a test at its own limit.",
    levels: ["unit"],
  },
  {
    id: "F239-42-2",
    implementation: [{ file: "packages/workbench/test/declared-source.test.mjs", symbol: "delayListenerRegistration = false;" }],
    tests: [{ file: "packages/workbench/test/declared-source.test.mjs", id: "the ingress ACKs each valid view event once and routes only its source and status" }],
    expected: "The ingress ACK consumer test configures its own listener fixture and ends within its individual timeout when selected by name.",
    levels: ["unit"],
  },
  {
    id: "F239-48",
    implementation: [
      { file: "Makefile", symbol: "bundle-info = node scripts/platform/darwin/prepare-app-bundle.mjs" },
      { file: "scripts/platform/darwin/prepare-app-bundle.mjs", symbol: "function runningBundleProcesses(" },
      { file: "scripts/platform/darwin/prepare-app-bundle.mjs", symbol: "rmSync(contents, { recursive: true, force: true })" },
    ],
    tests: [
      { file: "scripts/test/bundle-preparation.test.mjs", id: "bundle preparation refuses a running bundle executable before removing Contents" },
      { file: "scripts/test/bundle-preparation.test.mjs", id: "bundle preparation recreates Contents when no process uses the bundle" },
    ],
    expected: "The Makefile bundle preparation refuses with the active process PID and target path before removing Contents, preserves the running bundle files, and recreates Contents when no process uses the bundle.",
    levels: ["unit"],
  },
  {
    id: "F239-43",
    implementation: [
      { file: "packages/host/wailsv3/src/plugin_host.go", symbol: "pluginHostReceived(plugin string, instance *pluginHostChannel" },
      { file: "packages/host/wailsv3/src/plugin_host_channel.go", symbol: "func (c *pluginHostChannels) current(plugin string, instance *pluginHostChannel) bool" },
      { file: "packages/host/tauriv2/src/plugin_host_channel.rs", symbol: "pub fn receive_from(" },
      { file: "packages/host/tauriv2/src/plugin_host_channel.rs", symbol: "pub(crate) fn late_message_error(" },
    ],
    tests: [
      { file: "packages/host/wailsv3/src/plugin_host_test.go", id: "TestPluginHostDelayedMessageFromDisposedInstanceIsNotRelayedAfterRecreate" },
      { file: "packages/host/wailsv3/src/plugin_host_test.go", id: "TestPluginHostMessageDuringCreationUsesTheRegisteredInstance" },
      { file: "packages/host/tauriv2/src/plugin_host_channel_test.rs", id: "a_delayed_callback_from_a_disposed_host_is_not_received_by_a_recreated_host" },
      { file: "packages/host/tauriv2/src/plugin_host_channel_test.rs", id: "a_callback_during_creation_uses_the_registered_instance_before_the_native_handle_is_stored" },
      { file: "packages/host/tauriv2/src/plugin_host_channel_test.rs", id: "a_late_provider_error_is_preserved_after_window_records_are_removed" },
    ],
    expected: "A callback from a disposed plugin-host instance is canceled before a replacement channel receives it, while current and creation-time callbacks remain valid; an explicit late provider error retains its captured plugin identity.",
    levels: ["unit"],
  },
  {
    id: "F239-46.1",
    implementation: [
      { file: "packages/host/wailsv3/src/source_origins.go", symbol: "func (o *sourceOrigins) create(" },
      { file: "packages/host/wailsv3/src/source_origins.go", symbol: "func (o *sourceOrigins) snapshot()" },
    ],
    tests: [
      { file: "packages/host/wailsv3/src/source_origins_test.go", id: "TestSourceOriginsDoesNotIssueAnUnsafeGeneration" },
      { file: "packages/host/wailsv3/src/source_origins_test.go", id: "TestPluginHostStartupReportsGenerationExhaustionBeforeCreatingAProvider" },
    ],
    expected: "Wails source generations use one atomic per-window floor and refuse exhaustion before creating a provider without changing source state.",
    levels: ["unit"],
  },
  {
    id: "F239-42-1",
    implementation: [{ file: "packages/workbench/declared-source.js", symbol: "ingressReady.catch((error) =>" }],
    tests: [{ file: "packages/workbench/test/declared-source.test.mjs", id: "listener registration failure remains observable without an early unhandled rejection" }],
    expected: "A listener-registration failure is observed immediately to prevent an early unhandled rejection, while startup consumers still receive the same rejected readiness promise.",
    levels: ["unit"],
  },
  {
    id: "F239-42",
    implementation: [
      { file: "packages/workbench/declared-source.js", symbol: "export function startDeclaredSnapshotIngress()" },
      { file: "packages/workbench/declared-source.js", symbol: "createSnapshotReceiver({" },
      { file: "packages/workbench/index.html", symbol: "prepareDeclaredSnapshotIngress()" },
      { file: "packages/workbench/index.html", symbol: "afterDeclaredSnapshotIngress(() => {})" },
    ],
    tests: [
      { file: "packages/workbench/test/declared-section.test.mjs", id: "sections sharing a source acknowledge only snapshots of their own status" },
      { file: "packages/workbench/test/declared-section.test.mjs", id: "a hidden status keeps its sender moving while another status section is mounted" },
      { file: "packages/workbench/test/declared-section.test.mjs", id: "a push before a section mounts releases its sender slot before the next push" },
      { file: "packages/workbench/test/declared-source.test.mjs", id: "the ingress ACKs each valid view event once and routes only its source and status" },
      { file: "packages/workbench/test/declared-source-no-host.test.mjs", id: "a page without a native bridge starts ingress without a fallback transport" },
    ],
    expected: "One window ingress validates and acknowledges every pushed snapshot once, routes it by plugin, source and status, and releases sender slots when no matching section is mounted. Provider startup waits for ingress readiness, and a page without a native bridge starts without a fallback transport.",
    levels: ["unit"],
  },
  {
    id: "F239-41",
    implementation: [
      { file: "packages/workbench/declared-source.js", symbol: "export function startDeclaredSnapshotIngress()" },
      { file: "packages/workbench/declared-section.js", symbol: "const ready = link.onMessage" },
      { file: "packages/plugin-api/snapshots.js", symbol: "export function createSnapshotReceiver" },
    ],
    tests: [
      { file: "packages/workbench/test/declared-section.test.mjs", id: "the first push is subscribed before the source is pulled" },
      { file: "packages/workbench/test/declared-section.test.mjs", id: "a source change before subscription readiness unsubscribes late and never pulls the old source" },
      { file: "packages/workbench/test/declared-section.test.mjs", id: "closing before subscription readiness unsubscribes late and never pulls" },
      { file: "packages/workbench/test/declared-section.test.mjs", id: "reconciling the ready source again keeps one listener and one pull" },
      { file: "packages/workbench/test/declared-source.test.mjs", id: "a view channel resolves readiness only after the runtime listener is installed" },
      { file: "packages/plugin-api/test/snapshots.test.mjs", id: "the receiver resolves an asynchronous subscription after it installs its listener" },
    ],
    expected: "The workbench installs the snapshot listener before pulling a chosen source, accepts a push that arrives before the pull reply, rejects invalid unsubscribe results, and releases a delayed subscription after its source becomes obsolete.",
    levels: ["unit"],
  },
  {
    id: "F239-41-1",
    implementation: [
      { file: "packages/workbench/declared-section.js", symbol: "mine !== generation" },
      { file: "packages/workbench/declared-source.js", symbol: "if (closed) return" },
    ],
    tests: [
      { file: "packages/workbench/test/declared-section.test.mjs", id: "a queued callback from the first A subscription is discarded after an A to B to A change" },
      { file: "packages/workbench/test/declared-source.test.mjs", id: "the channel delivers each snapshot of its surface and plugin, and the unsubscribe ends the delivery" },
    ],
    expected: "A snapshot callback changes a declared section only while the exact subscription generation that received it remains current, and a closed transport ignores callbacks already queued before unsubscribe.",
    levels: ["unit"],
  },
  {
    id: "F244",
    implementation: [{ file: "packages/workbench/tab-reports.js", symbol: "tabOrigin" }],
    tests: [
      { file: "packages/workbench/test/surface-view.test.mjs", id: "the start values of a view carry its params, origin, project and declarations" },
      { file: "packages/workbench/test/declared-ui-draw-time.test.mjs", id: "a list of 1000 items validates and draws every item" },
      { file: "scripts/test/check-release-paths.test.mjs", id: "release CLI inspects every executable in the bundle" },
      { file: "scripts/test/native-tests.test.mjs", id: "the native tests run one at a time, each with its start and end, and a failure fails the run" },
      { file: "scripts/test/node-tests.test.mjs", id: "a change under a package selects the test files of that package only" },
    ],
    expected: "A tab carries the origin that tab creation records, the release check resolves the workbench manifest through its exports, the native test runner output matches its normalization, and each test that a failed mount could hang ends at its limit.",
    levels: ["unit"],
  },
  {
    id: "F223",
    implementation: [{ file: "scripts/check-e2e.mjs", symbol: "auditE2ESource" }],
    tests: [{ file: "scripts/test/soksak-scripts.test.mjs", id: "window-source audit rejects forbidden control paths" }],
    expected: "The window-check source audit accepts a timer that records an observation through report and does not apply its timer rule to the harness tests, which run on mocked time.",
    levels: ["unit"],
  },
  {
    id: "F212.9-3-1",
    implementation: [
      { file: "packages/host/wailsv3/src/plugin_host_channel.go", symbol: "pluginHostMessage" },
      { file: "packages/host/tauriv2/src/plugin_host_channel.rs", symbol: "receive" },
    ],
    tests: [
      { file: "packages/host/wailsv3/src/plugin_host_channel_test.go", id: "TestPluginHostChannelForwardsOnlyTheRegistrationCalls" },
      { file: "packages/host/tauriv2/src/plugin_host_channel_test.rs", id: "the_host_forwards_only_the_registration_calls_and_refuses_every_other_call" },
    ],
    expected: "Both hosts relay the replies, the registration calls and the snapshots of a plugin host page to the main page without a surface, refuse every other call, post the theme and the messages of the main page to the ready document, and send plugin-host-ended when the host ends.",
    levels: ["unit"],
  },
  {
    id: "F212.9-3-2",
    implementation: [
      { file: "packages/workbench/plugin-host.js", symbol: "listenPluginHostCalls" },
      { file: "packages/workbench/exposure.js", symbol: "forwardHost" },
    ],
    tests: [
      { file: "packages/workbench/test/exposure.test.mjs", id: "a plugin host answers only a request without surface for a name that no surface registered" },
      { file: "packages/workbench/test/plugin-host-calls.test.mjs", id: "plugin-host-ended removes the registrations of the host and ends its open requests" },
    ],
    expected: "The main page answers the registration calls of a plugin host under plugin:<plugin id>, answers a request without surface through the host only when no surface page registered the name, and removes the registrations when the host ends.",
    levels: ["unit"],
  },
  {
    id: "F212.9-3-3",
    implementation: [{ file: "packages/workbench/declared-source.js", symbol: "createDeclaredSource" }],
    tests: [
      { file: "packages/workbench/test/declared-source.test.mjs", id: "the channel of a plugin host source acknowledges through pluginHostEvent and delivers the snapshots of its plugin" },
      { file: "packages/workbench/test/declared-source.test.mjs", id: "the pull of a plugin host source runs the snapshot request through the layer of its host" },
    ],
    expected: "The source of a plugin host receives the snapshots of its plugin without a surface, acknowledges through pluginHostEvent and pulls through the request layer of the host.",
    levels: ["unit"],
  },

  {
    id: "F219",
    implementation: [{ file: "packages/host/tauriv2/tests/sidecars_test.rs", symbol: "static SERIAL: Mutex<()>" }],
    tests: [
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "stops_at_the_fourth_failure_within_the_window" },
      { file: "packages/host/tauriv2/tests/sidecars_test.rs", id: "surface_open_clears_the_restart_limit" },
    ],
    expected: "The tests of the sidecar suite that attach the process-wide writer of the records run one at a time, so the records of each test stay in its own event log whichever test attaches first.",
    levels: ["unit"],
  },
  {
    id: "F217",
    implementation: [{ file: "packages/workbench/plane.js", symbol: "function pluginPlaceholder(tab, paramsProblem)" }],
    tests: [
      { file: "packages/workbench/test/plane-placeholder-error.test.mjs", id: "a placeholder whose install state cannot be read is an error shown once, and withdrawn when its surface leaves" },
      { file: "packages/workbench/test/plane-placeholder-params.test.mjs", id: "a stored tab whose params do not match its plugin is an error shown once, and withdrawn when its surface leaves" },
      { file: "packages/workbench/test/plane-placeholder-reasons.test.mjs", id: "the placeholder reasons that are designed states write no error" },
    ],
    expected: "A tab whose install state cannot be read, or whose stored params do not match its loaded plugin, shows its placeholder error once through the error display path at the place of its surface, and the draw withdraws it when the surface leaves; the designed placeholder reasons write no error.",
    levels: ["unit"],
  },
  {
    id: "F209",
    implementation: [{ file: "packages/workbench/plugin-operations.js", symbol: "export function pluginRows(loaded, state)" }],
    tests: [{ file: "packages/workbench/test/plugin-operations.test.mjs", id: "a plugin whose every registry version is revoked is not offered, and an installed one keeps its row without an update" }],
    expected: "A plugin whose every registry version is revoked has no install action and no latest version.",
    levels: ["unit"],
  },
  {
    id: "F208",
    implementation: [{ file: "packages/workbench/exposure.json", symbol: "\"name\": \"core.library.choose-folder\"" }],
    tests: [{ file: "packages/workbench/test/dialog-command-timeout.test.mjs", id: "every declared command that shows a dialog is listed with its host call" }],
    expected: "Each declared command that shows a system dialog or save panel has a timeout of 600000 ms.",
    levels: ["unit"],
  },
  {
    id: "F201",
    implementation: [{ file: "native/darwin/src/document_view.m", symbol: "void sp_document_store_close(" }],
    tests: [{ file: "native/darwin/tests/document_view_test.m", id: "the data stores end without an error" }],
    expected: "A check ends the data store of its document directory before it removes the folder, so nothing writes into it afterward.",
    levels: ["unit"],
  },
  {
    id: "F202",
    implementation: [{ file: "native/darwin/src/document_view.m", symbol: "@interface SPHiddenDelay : NSObject" }],
    tests: [{ file: "native/darwin/tests/window_release_test.m", id: "the closed window releases its" }],
    expected: "A closed document region is released before its hidden clear delay passes.",
    levels: ["unit"],
  },
  {
    id: "F245",
    implementation: [{ file: "packages/plugin-api/surface-composition.js", symbol: "Object.defineProperty(exposed, \"history\"" }],
    tests: [{ file: "packages/plugin-api/test/surface-composition.test.mjs", id: "a view composition region reports the history of its attach reply" }],
    expected: "The region of a view composition reports the history of its attach reply, as the document handle of a page does.",
    levels: ["unit"],
  },
  {
    id: "F198",
    implementation: [{ file: "packages/workbench/memory-saver.js", symbol: "export function createMemorySaver" }],
    tests: [{ file: "packages/workbench/test/memory-saver.test.mjs", id: "the delay unloads a hidden tab and a show restores it" }],
    expected: "The memory saver unloads a hidden tab after the delay and a show restores it from its stored state.",
    levels: ["unit"],
  },
  {
    id: "F191",
    implementation: [{ file: "scripts/release-step.sh", symbol: "release-step-ok" }],
    tests: [{ file: "scripts/test/release-step.test.mjs", id: "the release step script writes the released form, runs the host once and requires the migration and its record" }],
    expected: "A release runs the migration step script on a release-built host and publishes both bundles.",
    levels: ["unit"],
  },
  {
    id: "F183",
    implementation: [{ file: "Makefile", symbol: "release-check: wailsv3-build-release tauriv2-build-release registry-manifest-check" }],
    tests: [{ file: "scripts/test/workflows.test.mjs", id: "the release workflow runs a release-built host once on the stored data of the earlier release" }],
    expected: "A release publishes both bundles from a tag whose CI passed and runs a release-built host once on the stored data of the earlier release.",
    levels: ["unit"],
  },
  {
    id: "F188",
    implementation: [{ file: "packages/sok/wailsv3/src/migrate.go", symbol: "func MigrateInstalled" }],
    tests: [{ file: "packages/sok/wailsv3/tests/migrate_test.go", id: "TestMigrateInstalledMigratesTheReleasedFormat2ToTheCurrentFormat" }],
    expected: "Stored data migrates mechanically from definitions that the package ships, performed by core.",
    levels: ["unit"],
  },
  {
    id: "F190",
    implementation: [
      { file: "packages/sok/wailsv3/src/ownership.go", symbol: "func ownConfiguration" },
      { file: "packages/sok/tauriv2/src/ownership.rs", symbol: "pub(crate) fn own_configuration" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/ownership_test.go", id: "TestAPluginCommandRefusesWhileAnotherProcessOwnsTheConfiguration" },
      { file: "packages/sok/tauriv2/tests/ownership_test.rs", id: "a_plugin_command_refuses_while_another_process_owns_the_configuration" },
    ],
    expected: "A writing sok plugin command owns the configuration directory for the duration of its write.",
    levels: ["unit"],
  },
  {
    id: "F188.5",
    implementation: [
      { file: "packages/sok/wailsv3/src/migrate.go", symbol: "func MigrateProjects" },
      { file: "packages/host/wailsv3/src/workspace.go", symbol: "func readProjects" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/migrate_test.go", id: "TestMigrateProjectsWrapsTheBareListOfTheEarlierForm" },
      { file: "packages/sok/tauriv2/tests/migrate_test.rs", id: "migrate_projects_wraps_the_bare_list_of_the_earlier_form" },
    ],
    expected: "projects.json carries its form in a format member beside the projects member, migrated from the bare array at the first read.",
    levels: ["unit"],
  },
  {
    id: "F188.4",
    implementation: [
      { file: "packages/sok/wailsv3/src/migrate.go", symbol: "func MigrateSettings" },
      { file: "packages/host/wailsv3/src/workspace.go", symbol: "sok.MigrateSettings(w.directory)" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/migrate_test.go", id: "TestMigrateSettingsAddsTheFormatNumberOfTheFormWithoutOne" },
      { file: "packages/sok/tauriv2/tests/migrate_test.rs", id: "migrate_settings_adds_the_format_number_of_the_form_without_one" },
    ],
    expected: "settings.json carries its form in a format member migrated at the first read of the workspace layer.",
    levels: ["unit"],
  },
  {
    id: "F189",
    implementation: [{ file: ".github/workflows/release.yml", symbol: "Migrate the stored data of the earlier release" }],
    tests: [{ file: "scripts/test/workflows.test.mjs", id: "the release workflow runs a release-built host once on the stored data of the earlier release" }],
    expected: "A release runs a release-built host once on the stored data of the earlier release, and the chain, the format mentions and the step are checked mechanically.",
    levels: ["unit"],
  },
  {
    id: "F188.2",
    implementation: [
      { file: "packages/sok/wailsv3/src/migrate.go", symbol: "func MigrateInstalled" },
      { file: "packages/sok/tauriv2/src/migrate.rs", symbol: "pub fn migrate_installed" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/migrate_test.go", id: "TestMigrateInstalledMigratesTheReleasedFormat2ToTheCurrentFormat" },
      { file: "packages/sok/tauriv2/tests/migrate_test.rs", id: "migrate_installed_migrates_the_released_format_2_to_the_current_format" },
    ],
    expected: "The engine of both command lines migrates the released format-2 form to the current format, idempotently, refusing forms outside the chain.",
    levels: ["unit"],
  },
  {
    id: "F188.3",
    implementation: [
      { file: "packages/sok/wailsv3/src/plugins.go", symbol: "if _, err := MigrateInstalled(configDir); err != nil {" },
      { file: "packages/sok/tauriv2/src/plugins.rs", symbol: "crate::migrate::migrate_installed(config_dir)?;" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/install_test.go", id: "TestInstalledFileOfAnotherFormatIsRejected" },
      { file: "packages/sok/tauriv2/tests/plugins_test.rs", id: "an_installed_file_of_another_format_is_rejected" },
    ],
    expected: "The shared reader entry of installed.json migrates before it reads, in every process.",
    levels: ["unit"],
  },
  {
    id: "F186",
    implementation: [{ file: "native/darwin/src/observe.m", symbol: "id sp_observe_workspace_notification" }],
    tests: [{ file: "native/darwin/tests/activity_observers_test.m", id: "the activation names the application that was frontmost before it" }],
    expected: "The activation of the application records the application that was frontmost before it.",
    levels: ["unit"],
  },
  {
    id: "F185",
    implementation: [{ file: "packages/host/tauriv2/tests/event_native_platform_test.rs", symbol: "static SERIAL: Mutex<()>" }],
    tests: [{ file: "packages/host/tauriv2/tests/event_native_platform_test.rs", id: "the_platform_pulls_an_empty_native_ring_as_zero_bytes_and_no_loss" }],
    expected: "The native platform tests of the Tauri host run one at a time and read an emptied ring.",
    levels: ["unit"],
  },
  {
    id: "F184",
    implementation: [
      { file: "packages/workbench/log-batch.js", symbol: "page = String(performance.timeOrigin)" },
      { file: "packages/host/wailsv3/src/running_calls.go", symbol: "func ReloadTimeoutText" },
      { file: "packages/host/tauriv2/src/running_calls.rs", symbol: "pub fn reload_timeout_text" },
    ],
    tests: [
      { file: "packages/log-contract/test/audit.test.mjs", id: "an event of the layer page or plugin names the page that wrote it, and an event of another layer names none" },
      { file: "packages/workbench/test/log-batch.test.mjs", id: "every event of a batch names the page that wrote it by its time origin, the anchor of its clock included" },
      { file: "packages/host/wailsv3/tests/running_calls_test.go", id: "TestAReloadThatTimesOutNamesTheHostCallsOfItsWindowThatStillRun" },
      { file: "packages/host/tauriv2/tests/running_calls_test.rs", id: "a_reload_that_times_out_names_the_host_calls_of_its_window_that_still_run" },
    ],
    expected: "Every page and plugin event names the page that wrote it, and a reload that times out names the host calls it waited for.",
    levels: ["unit"],
  },
  {
    id: "F181",
    implementation: [
      { file: "packages/host/tauriv2/src/debug.rs", symbol: "pub(crate) fn save_all(window: &Window) -> Result<SaveAllStarted, String>" },
      { file: "packages/host/wailsv3/src/debug.go", symbol: "func (h *Host) DebugSaveAll(ctx context.Context) (DebugSaveAllStarted, error)" },
      { file: "packages/workbench/debug-ui.js", symbol: "export async function saveDebugFiles()" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/debug_test.rs", id: "debug_write_logs_tar_reports_progress_each_mebibyte_and_at_the_end" },
      { file: "packages/host/wailsv3/tests/debug_test.go", id: "TestDebugWriteLogsTarReportsProgressEachMebibyteAndAtTheEnd" },
      { file: "packages/workbench/test/debug-save-ui.test.mjs", id: "a save while one writes is refused and shown, and a failure of the write is shown" },
      { file: "packages/host/tauriv2/tests/modals_test.rs", id: "a_reply_of_a_modal_that_is_not_open_is_dropped_with_the_fields_of_its_record" },
      { file: "packages/host/wailsv3/tests/modals_test.go", id: "TestAReplyOfAModalThatIsNotOpenIsDroppedWithTheFieldsOfItsRecord" },
      { file: "packages/workbench/test/overlay-pick.test.mjs", id: "a reply of a modal that the page does not show is recorded as page.overlay.dropped" },
    ],
    expected: "A save of the logs folder shows its progress, refuses a second save while it writes, and every dropped modal reply is recorded.",
    levels: ["unit"],
  },
  {
    id: "F180",
    implementation: [{ file: "scripts/node-tests.mjs", symbol: "const { values } = parseArgs({" }],
    tests: [
      { file: "scripts/test/check-app-update.test.mjs", id: "Unknown option '--other'" },
      { file: "scripts/test/check-release-paths.test.mjs", id: "Unknown option '--unknown'" },
    ],
    expected: "Every script reads its command line with parseArgs of node:util and refuses an unknown or repeated option.",
    levels: ["unit"],
  },
  {
    id: "F179",
    implementation: [
      { file: "packages/sok/tauriv2/src/event_log.rs", symbol: "const GATED_REPORT_INTERVAL" },
      { file: "packages/sok/wailsv3/src/event_log.go", symbol: "const gatedReportInterval" },
      { file: "packages/workbench/log-batch.js", symbol: "const GATED_REPORT_MS" },
      { file: "native/darwin/src/event_ring.m", symbol: "static const uint64_t GATED_REPORT_NS" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/producer_gate_test.rs", id: "the_counts_of_a_closed_gate_are_reported_each_second_and_at_a_flush" },
      { file: "packages/host/wailsv3/tests/producer_gate_test.go", id: "TestTheCountsOfAClosedGateAreReportedEachSecondAndAtAFlush" },
      { file: "packages/workbench/test/log-gate.test.mjs", id: "the counts of a closed gate leave each second and at a flush, not with each batch" },
      { file: "native/darwin/tests/event_ring_test.m", id: "a drain within a second of the earlier report reports no count" },
    ],
    expected: "The counts of refused events leave each second and at a flush in every writer.",
    levels: ["unit"],
  },
  {
    id: "F178",
    implementation: [{ file: "packages/sok/tauriv2/src/event_log.rs", symbol: "let mut due = Instant::now() + interval;" }],
    tests: [
      { file: "packages/host/tauriv2/tests/event_log_test.rs", id: "a_steady_stream_of_events_is_written_at_each_batch_interval" },
      { file: "packages/host/wailsv3/tests/event_log_test.go", id: "TestASteadyStreamOfEventsIsWrittenAtEachBatchInterval" },
    ],
    expected: "The event writer of each host writes its batch at each interval while events keep arriving.",
    levels: ["unit"],
  },
  {
    id: "F177",
    implementation: [{ file: "packages/log-contract/index.js", symbol: "const stored = (file, from, to, hop)" }],
    tests: [{ file: "packages/log-contract/test/audit.test.mjs", id: "a chain does not ask for a hop whose class and level the policy in force of the process does not store" }],
    expected: "A log audit asks a chain only for the hops that the policy in force stores.",
    levels: ["unit"],
  },
  {
    id: "F176",
    implementation: [{ file: "native/darwin/src/image_region.m", symbol: "- (void)failInput:(NSString *)reason" }],
    tests: [
      { file: "native/darwin/tests/image_region_test.m", id: "silent input method: the error with marked text" },
      { file: "packages/log-contract/test/audit.test.mjs", id: "a chain ends at an error event that carries its correlation identifier" },
    ],
    expected: "A key that the input method does not answer is reported as an error that carries the identifier of the key, and its chain ends at that error.",
    levels: ["unit"],
  },
  {
    id: "F175",
    implementation: [{ file: "scripts/audit-run.mjs", symbol: "const judged = (file, line)" }],
    tests: [{ file: "scripts/test/audit-run.test.mjs", id: "a chain finding of an earlier process before the first start mark belongs to no test of the run and is not judged" }],
    expected: "A run audit judges only the findings on lines inside the span of the run.",
    levels: ["unit"],
  },
  {
    id: "F174",
    implementation: [{ file: "packages/window-check/event-log.mjs", symbol: "export function sessionEventStart" }],
    tests: [{ file: "packages/window-check/test/event-log.test.mjs", id: "without stored offsets the session starts at the end of the files of ended processes and at the start of the running one" }],
    expected: "A window check judges the errors of the running process from its session start, never the history of earlier processes.",
    levels: ["unit"],
  },
  {
    id: "F173",
    implementation: [{ file: "Makefile", symbol: "census.test.mjs scripts/test/fallbacks.test.mjs" }],
    tests: [{ file: "scripts/test/workflows.test.mjs", id: "the push check runs every check of the structure step and the format and clippy checks of ci" }],
    expected: "A push runs the census and fallback tests of the sources, so a registration outside its entrance or an unexplained default does not reach main.",
    levels: ["unit"],
  },
  {
    id: "F171",
    implementation: [{ file: "packages/host/wailsv3/src/stall_watch.go", symbol: "func StartStallWatch" }],
    tests: [{ file: "packages/host/wailsv3/tests/stall_watch_test.go", id: "TestABlockedMainThreadIsRecordedWithItsStacksAndItsEnd" }],
    expected: "A stall of the main thread is recorded with its stacks, which show where AppKit waits.",
    levels: ["unit"],
  },
  {
    id: "F170",
    implementation: [{ file: "Makefile", symbol: "push-check:" }],
    tests: [{ file: "scripts/test/workflows.test.mjs", id: "the push check runs every check of the structure step and the format and clippy checks of ci" }],
    expected: "A push runs the commit, structure, format and clippy checks of CI before it leaves the checkout.",
    levels: ["unit"],
  },
  {
    id: "F169",
    implementation: [{ file: ".node-version", symbol: "26.11.1" }],
    tests: [{ file: "scripts/test/check-build-environment.sh", id: "valid workspace toolchain reports its measured build environment" }],
    expected: "The build runs the Node version that .node-version declares, and another version stops the preflight.",
    levels: ["unit"],
  },
  {
    id: "F168",
    implementation: [{ file: "packages/sok/tauriv2/Cargo.toml", symbol: 'edition = "2024"' }],
    tests: [{ file: "packages/sok/tauriv2/tests/sok_test.rs", id: "the_default_configuration_directory_is_the_applications" }],
    expected: "The Rust packages build with edition 2024, and no test changes the environment of its process.",
    levels: ["unit"],
  },
  {
    id: "F167",
    implementation: [{ file: "packages/plugin-api/terms.json", symbol: '"term": "image region"' }],
    tests: [{ file: "packages/plugin-api/test/records-check.test.mjs", id: "a rejected synonym is reported with the term to use, also in identifiers" }],
    expected: "The image region has one term, and a record that uses its rejected synonym is refused with the term to use.",
    levels: ["unit"],
  },
  {
    id: "F165",
    implementation: [
      { file: "packages/host/wailsv3/src/images.go", symbol: "func imageReply" },
      { file: "packages/host/tauriv2/src/images.rs", symbol: "fn image_reply" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/images_test.go", id: "TestFailedPresentIsReported" },
      { file: "packages/host/tauriv2/tests/images_test.rs", id: "failed_present_is_reported" },
    ],
    expected: "Every error answer of an image envelope carries the name, generation, raster and sequence of its frame.",
    levels: ["unit"],
  },
  {
    id: "F164",
    implementation: [
      { file: "packages/host/wailsv3/src/stall_watch.go", symbol: "func StartStallWatch" },
      { file: "packages/host/tauriv2/src/stall_watch.rs", symbol: "pub fn start_stall_watch" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/stall_watch_test.go", id: "TestABlockedMainThreadIsRecordedWithItsStacksAndItsEnd" },
      { file: "packages/host/tauriv2/tests/stall_watch_test.rs", id: "a_blocked_main_thread_is_recorded_with_its_stacks_and_its_end" },
    ],
    expected: "A stall of the main thread of either host of 1 s or more is recorded with the stacks of the threads and its end, without a window check.",
    levels: ["unit"],
  },
  {
    id: "F163",
    implementation: [{ file: "packages/workbench/plugin-operations.js", symbol: "first run: the starter pack ${failedPack} was not installed: ${error?.message ?? error}" }],
    tests: [{ file: "packages/workbench/test/plugin-operations.test.mjs", id: "a first run that cannot read the registry starts the window without the pack and states why" }],
    expected: "A first run without a network, or with a registry that cannot be read, starts the window without the starter pack, states why, and installs the pack at the next start.",
    levels: ["unit"],
  },
  {
    id: "R3",
    implementation: [
      { file: "packages/plugin-api/records-check.js", symbol: "export function recordViolations" },
      { file: "packages/plugin-api/records-check.js", symbol: "export function commitMessageErrors" },
    ],
    tests: [
      { file: "packages/plugin-api/test/records-check.test.mjs", id: "record checks report each statement that is not a fact about the repository" },
      { file: "packages/plugin-api/test/records-check.test.mjs", id: "commit messages use the subject form with a checklist ID, a body and no footer" },
    ],
    expected: "The records of core and of every plugin, sidecar and registry repository state facts about their repository, and each commit message carries the checklist ID in its subject and no footer.",
    levels: ["unit"],
  },
  {
    id: "R5",
    implementation: [{ file: "packages/plugin-api/records-check.js", symbol: "export function termViolations" }],
    tests: [
      { file: "packages/plugin-api/test/records-check.test.mjs", id: "a rejected synonym is reported with the term to use, also in identifiers" },
      { file: "packages/plugin-api/test/records-check.test.mjs", id: "a rejected synonym joined inside an identifier is reported" },
    ],
    expected: "Each concept has one term in the code, the specifications and the records of every repository, and the record check reports a rejected synonym with the term to use.",
    levels: ["unit"],
  },
  {
    id: "F144",
    implementation: [{ file: "native/darwin/src/image_region.m", symbol: "[self logInput:@\"insertText\" fields:fields before:before];" }],
    tests: [{ file: "e2e/input-records.test.mjs", id: "a typed key leaves a record in every layer of the input path" }],
    expected: "Each layer of the input path records what it received, decided and sent with the typed text and every field, so a defect of the input is located from the files alone.",
    levels: ["application"],
  },
  {
    id: "F145",
    implementation: [{ file: "packages/host/wailsv3/src/endpoint.go", symbol: "func (c *endpointConn) close(reason string)" }],
    tests: [{ file: "e2e/input-records.test.mjs", id: "a typed key leaves a record in every layer of the input path" }],
    expected: "The gaps of the records that the audit of 2026-10-09 listed are closed by their children, each with its own tests.",
    levels: ["unit", "application"],
  },
  {
    id: "F160.25",
    implementation: [
      { file: "packages/sok/wailsv3/src/replay.go", symbol: "func ReplayLogs" },
      { file: "packages/plugin-api/screen-hash.js", symbol: "export async function screenHash" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/replay_test.go", id: "TestReplayComparesEachSegmentOfASessionWhoseSequenceRestarts" },
      { file: "packages/sok/tauriv2/tests/replay_test.rs", id: "replay_compares_each_segment_of_a_session_whose_sequence_restarts" },
      { file: "e2e/terminal-replay.test.mjs", id: "a session with output, a resize, a scroll, a selection, a theme and input replays with every hash equal" },
      { file: "e2e/terminal-replay.test.mjs", id: "a stored input that was changed is a divergence of the layer sidecar" },
    ],
    expected: "A terminal session replays from its stored inputs with every sidecar and page hash equal, and a changed stored input or drawn screen is a divergence of the layer that stored it.",
    levels: ["unit", "application"],
  },
  {
    id: "F160.34",
    implementation: [
      { file: "packages/plugin-api/events-check.js", symbol: "export function parseCensusConfig" },
      { file: "packages/sok/wailsv3/src/replay_inputs.go", symbol: "func ReplaySessionProblem" },
      { file: "packages/sok/tauriv2/src/replay_inputs.rs", symbol: "pub fn replay_session_problem" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/replay_inputs_test.go", id: "TestTheReplayInputRulesReproduceTheGoldenCases" },
      { file: "packages/sok/tauriv2/tests/replay_inputs_test.rs", id: "the_replay_input_rules_reproduce_the_golden_cases" },
      { file: "packages/sok/wailsv3/tests/log_policy_test.go", id: "TestThePolicyReaderRefusesEveryInvalidGoldenCaseWithItsText" },
      { file: "packages/sok/tauriv2/tests/log_policy_test.rs", id: "the_policy_reader_refuses_every_invalid_golden_case_with_its_text" },
    ],
    expected: "The catalog check finds the emit sites of a Rust sidecar through its declared emitters, the readers of the policy file reproduce its golden cases, and the replay checks the view-state inputs of a session with the rules of a session before it applies them.",
    levels: ["unit"],
  },
  {
    id: "F236",
    implementation: [{ file: "scripts/check-test-parity.mjs", symbol: "function declaredOwners(root)" }],
    tests: [{ file: "scripts/test/test-parity.test.mjs", id: "ownership audit classifies only declared names, by exact name" }],
    expected: "The ownership audit names no real plugin or sidecar: it classifies a package by its name prefix. The decoupling items F236-1 to F236-12 keep their evidence in docs/features.md, and the moves they name are in docs/plans/decouple-handoff.md.",
    levels: ["unit"],
  },
  {
    id: "F160.35",
    implementation: [
      { file: "packages/plugin-api/screen-hash.js", symbol: "export function screenFromMessage" },
      { file: "packages/sok/wailsv3/src/replay.go", symbol: "func ReplayLogs" },
    ],
    tests: [
      { file: "packages/log-contract/test/screen-message.test.mjs", id: "is refused with the error of the fixture" },
      { file: "packages/plugin-api/test/screen-hash.test.mjs", id: "a screen message without a segment is refused with the member named" },
      { file: "packages/sok/wailsv3/tests/replay_test.go", id: "TestReplayRefusesAPageFrameThatNamesNoSegmentOfTheSession" },
      { file: "packages/sok/tauriv2/tests/replay_test.rs", id: "replay_refuses_a_page_frame_that_names_no_segment_of_the_session" },
      { file: "e2e/terminal-replay.test.mjs", id: "a terminal session replays with the sidecar and page hashes equal" },
      { file: "e2e/terminal-replay.test.mjs", id: "a screen message changed on the way is a divergence of the layer plugin" },
    ],
    expected: "The screen message carries the members of the screen hash and its segment, the page hashes the grid it received into a frame record of the layer plugin, and the replay of a terminal session finds every sidecar and page hash equal and reports a message changed on the way as a divergence of the layer plugin.",
    levels: ["unit", "application"],
  },
  {
    id: "F160.36",
    implementation: [
      { file: "packages/sok/wailsv3/src/plugin_catalog.go", symbol: "func PluginEventClasses" },
      { file: "packages/sok/tauriv2/src/plugin_catalog.rs", symbol: "pub fn plugin_event_classes" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/plugin_catalog_test.go", id: "TestAPluginEventHasTheClassThatTheCatalogOfItsPluginDeclares" },
      { file: "packages/sok/tauriv2/tests/plugin_catalog_test.rs", id: "a_plugin_event_has_the_class_that_the_catalog_of_its_plugin_declares" },
      { file: "packages/host/wailsv3/tests/plugin_catalog_test.go", id: "TestTheHostClassifiesPluginEventsByTheInstalledCatalogsAndRecordsACatalogItCannotUse" },
      { file: "packages/host/tauriv2/tests/plugin_catalog_test.rs", id: "the_host_classifies_plugin_events_by_the_installed_catalogs_and_records_a_catalog_it_cannot_use" },
      { file: "e2e/terminal-replay.test.mjs", id: "a terminal session replays with the sidecar and page hashes equal" },
    ],
    expected: "The writer of each host stores a plugin event with the class that the catalog of its enabled installed plugin declares, and records a catalog it cannot use as an error that names the file.",
    levels: ["unit", "application"],
  },
  {
    id: "F157",
    implementation: [
      { file: "packages/workbench/debug-timeline.js", symbol: "export const HOLD_LIMIT" },
    ],
    tests: [
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "the view holds at most 2000 rows and refuses an older page beyond them with an error" },
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "the rows beyond the hold limit leave the view from the old end and are counted" },
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "the timeline asks at each notice without a pause of its own and loses no row" },
      { file: "packages/sok/wailsv3/tests/debug_test.go", id: "TestQueryRefusesWhatBreaksTheContract" },
      { file: "packages/sok/tauriv2/tests/debug_test.rs", id: "query_refuses_what_breaks_the_contract" },
    ],
    expected: "The page of the debug view keeps answering when an event file is large and grows: the timeline holds and draws a bounded number of rows, answers each notice of the host without a timer of its own, and reads a file without a line as no row.",
    levels: ["unit"],
  },
  {
    id: "F155",
    implementation: [
      { file: "packages/host/tauriv2/src/startup.rs", symbol: "pub fn exit_on_failure_with" },
      { file: "packages/host/wailsv3/src/startup.go", symbol: "func ExitOnFailureWith" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/startup_test.rs", id: "a_failed_setup_step_writes_its_message_and_exits_with_status_one" },
      { file: "packages/host/wailsv3/tests/startup_test.go", id: "TestAFailedStartupStepWritesItsMessageAndExitsWithStatusOne" },
    ],
    expected: "A failure of a startup step of the Tauri host writes its message and ends the process with the status 1 instead of aborting it.",
    levels: ["unit", "application"],
  },
  {
    id: "F160.26",
    implementation: [{ file: "scripts/node-tests.mjs", symbol: "export function whenIdle" }],
    tests: [{ file: "scripts/test/node-tests.test.mjs", id: "the idle gate waits until the person gave no input for the given seconds" }],
    expected: "The wait of --when-idle reads the idle time of the input at an interval; the examined event sources and the reason each cannot serve are in docs/operations/examples.md.",
    levels: ["unit"],
  },
  {
    id: "F160.31",
    implementation: [
      { file: "packages/sok/wailsv3/src/event_log.go", symbol: "func StartEventLog" },
      { file: "packages/sok/tauriv2/src/event_log.rs", symbol: "pub fn start" },
    ],
    tests: [
      { file: "packages/sok/wailsv3/tests/event_log_options_test.go", id: "TestAWriterRotatesAtItsBoundAndTheNewFileStartsWithLogOpenAndLogRotated" },
      { file: "packages/sok/tauriv2/tests/event_log_options_test.rs", id: "a_writer_rotates_at_its_bound_and_the_new_file_starts_with_log_open_and_log_rotated" },
    ],
    expected: "The hosts and the tool start one event writer per language, which lives in the tool packages and takes the layer, the clock, the thread entrance, the rotation and a pull as options.",
    levels: ["unit"],
  },
  {
    id: "F160.27",
    implementation: [
      { file: "packages/host/tauriv2/src/recording.rs", symbol: "pub fn running" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/recording_test.rs", id: "a_poisoned_recording_state_is_recovered_when_it_ends" },
    ],
    expected: "A discarded Rust result is either reported as a record or carries a stated reason: a poisoned lock is a record.",
    levels: ["unit"],
  },
  {
    id: "F160.5.2",
    implementation: [
      { file: "packages/host/tauriv2/src/binding_record.rs", symbol: "pub fn finish" },
      { file: "packages/host/wailsv3/src/binding_record.go", symbol: "func (b *Bindings) Call" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/binding_record_test.rs", id: "a_binding_call_is_an_event_while_the_trace_is_off" },
      { file: "packages/host/wailsv3/tests/binding_record_test.go", id: "TestABindingCallIsAnEventWhileTheTraceIsOff" },
    ],
    expected: "Every host call of a page is stored by the host as the event host.binding.call with its name, bounded arguments, result and microseconds.",
    levels: ["unit"],
  },
  {
    id: "F160.6.4",
    implementation: [
      { file: "packages/sok/tauriv2/src/event_bounds.rs", symbol: "pub fn bounded_serialize" },
      { file: "packages/sok/wailsv3/src/event_bounds.go", symbol: "func BoundedMarshal" },
      { file: "packages/workbench/log-batch.js", symbol: "export function createEventBatcher" },
    ],
    tests: [
      { file: "packages/host/tauriv2/tests/producer_bounds_test.rs", id: "the_fields_of_a_host_event_are_cut_while_they_are_serialized" },
      { file: "packages/host/wailsv3/tests/producer_bounds_test.go", id: "TestTheFieldsOfAHostEventAreCutWhileTheyAreSerialized" },
      { file: "packages/workbench/test/page-bounds.test.mjs", id: "the fields of an event of a plugin over 65536 bytes are replaced by their head while they are serialized" },
    ],
    expected: "A producer cuts the fields, the records and the queues to their bounds while it serializes them, and every cut or refusal is stored.",
    levels: ["unit"],
  },
  {
    id: "F160.11",
    implementation: [
      { file: "scripts/test-runner.mjs", symbol: "export async function runTests" },
    ],
    tests: [
      { file: "scripts/test/test-runner.test.mjs", id: "a run with a folder gives each test its identifier, stores the output of every test and writes a manifest" },
      { file: "scripts/test/test-runner.test.mjs", id: "a manifest names a test that is still running, so a run that stops leaves the test it stopped in" },
    ],
    expected: "A run gives each test its identifier and keeps a manifest with the status, start and end of each test, naming the test a stopped run was in.",
    levels: ["unit"],
  },
  {
    id: "F160.32.1",
    implementation: [
      { file: "packages/plugin-api/plugin-runtime.js", symbol: "export function createPluginRuntime" },
      { file: "packages/workbench/plugin-records.js", symbol: "export const pluginRecords" },
    ],
    tests: [
      { file: "packages/plugin-api/test/surface.test.mjs", id: "a plugin event carries the cids of its chain to the page writer" },
      { file: "packages/workbench/test/plugin-records.test.mjs", id: "an event of a plugin leaves with its cids and its builder runs while the level is stored" },
    ],
    expected: "A plugin event carries valid cids to the page writer, and an invalid cids argument throws before anything is stored.",
    levels: ["unit"],
  },
  {
    id: "F160.32.2",
    implementation: [
      { file: "packages/plugin-api/plugin-runtime.js", symbol: "trace.enabled" },
      { file: "packages/workbench/page-log.js", symbol: "export function eventEnabled" },
    ],
    tests: [
      { file: "packages/plugin-api/test/surface.test.mjs", id: "a plugin has no level query: each record builds its fields, and a page without a host builds none" },
      { file: "packages/plugin-api/test/surface.test.mjs", id: "a plugin trace builds its fields only while the trace is on" },
      { file: "packages/workbench/test/plugin-records.test.mjs", id: "the trace of a plugin builds no object while the trace is off" },
    ],
    expected: "The fields of a plugin event and of a plugin trace event are built only while the level is stored or the trace is on.",
    levels: ["unit"],
  },
  {
    id: "F160.32.3",
    implementation: [
      { file: "packages/plugin-api/events-check.js", symbol: "export function catalogReport" },
    ],
    tests: [
      { file: "packages/plugin-api/test/events-check.test.mjs", id: "the census exclude removes a vendored file before the catalog check parses it" },
    ],
    expected: "The catalog check does not read a file that the census exclude names.",
    levels: ["unit"],
  },
  {
    id: "F160.32.5",
    implementation: [
      { file: "packages/plugin-api/events-check.js", symbol: "const relativeName" },
    ],
    tests: [
      { file: "packages/plugin-api/test/events-check.test.mjs", id: "runtime.log entrances of plugin events are resolved by the plugin prefix" },
    ],
    expected: "The catalog check treats runtime.log.<level>( and runtime.log[level]( as entrances of plugin events.",
    levels: ["unit"],
  },
  {
    id: "F160.13",
    implementation: [
      { file: "scripts/test-runs.mjs", symbol: "export function pruneRuns" },
      { file: "scripts/node-tests.mjs", symbol: "export function newRun" },
    ],
    tests: [
      { file: "scripts/test/test-runs.test.mjs", id: "a run that passed is removed, and a run with an unclassified failure or a stop is kept and named" },
      { file: "scripts/test/test-runs.test.mjs", id: "a run whose failures are all named by a classification record is removed, and a partial record keeps it" },
      { file: "scripts/test/test-runs.test.mjs", id: "a malformed manifest or classification is an error that names the file" },
      { file: "scripts/test/node-tests.test.mjs", id: "a run is named by its start time and process id and keeps its folder under target/test-runs" },
    ],
    expected: "The output of every test and the evidence of a failed run stay until a classification names each failure.",
    levels: ["unit"],
  },
  {
    id: "F154.4.3",
    implementation: [
      { file: "scripts/node-tests.mjs", symbol: "export function parseTestScript" },
    ],
    tests: [
      { file: "scripts/test/node-tests.test.mjs", id: "another script of the packages that have it is discovered, and quotes around a glob are not part of the path" },
    ],
    expected: "The window-check files run one at a time through the test runner with the start, the end, the elapsed time and a limit of 600 s for each file.",
    levels: ["unit"],
  },
  {
    id: "F154.4",
    implementation: [
      { file: "scripts/node-tests.mjs", symbol: "export function discoverNodeTests" },
      { file: "scripts/native-tests.mjs", symbol: "export async function runNativeTests" },
    ],
    tests: [
      { file: "scripts/test/node-tests.test.mjs", id: "each test file of a package is a test with the folder and the flags of its package" },
      { file: "scripts/test/native-tests.test.mjs", id: "the native tests run one at a time, each with its start and end, and a failure fails the run" },
    ],
    expected: "The Node test files, the native tests and the window checks run through the test runner with the same output and limits.",
    levels: ["unit"],
  },
  {
    id: "F154.4.2",
    implementation: [
      { file: "scripts/native-tests.mjs", symbol: "export async function runNativeTests" },
    ],
    tests: [
      { file: "scripts/test/native-tests.test.mjs", id: "the native tests run one at a time, each with its start and end, and a failure fails the run" },
      { file: "scripts/test/native-tests.test.mjs", id: "a native test over its limit is killed and fails the run" },
    ],
    expected: "The native tests run one at a time through the test runner, each with its start, its end, its elapsed time and its own limit.",
    levels: ["unit"],
  },
  {
    id: "F154.4.1",
    implementation: [
      { file: "scripts/node-tests.mjs", symbol: "export function discoverNodeTests" },
    ],
    tests: [
      { file: "scripts/test/node-tests.test.mjs", id: "each test file of a package is a test with the folder and the flags of its package" },
      { file: "scripts/test/node-tests.test.mjs", id: "the discovered files run through the runner, each in the folder of its package" },
    ],
    expected: "Every Node test file of the workspace runs as a process of its own through the test runner with its own limit and the same output as the other long suites.",
    levels: ["unit"],
  },
  {
    id: "F151.6",
    implementation: [
      { file: "packages/sok/tauriv2/src/debug.rs", symbol: "pub(crate) fn run_debug" },
      { file: "packages/sok/wailsv3/src/debug.go", symbol: "func runDebug" },
      { file: "packages/workbench/debug-timeline.js", symbol: "export function eventLine" },
    ],
    tests: [
      { file: "packages/sok/tauriv2/tests/debug_test.rs", id: "query_prints_the_golden_lines_of_every_case" },
      { file: "packages/sok/tauriv2/tests/debug_test.rs", id: "query_refuses_what_breaks_the_contract" },
      { file: "packages/sok/tauriv2/tests/debug_test.rs", id: "query_refuses_an_invalid_flag_value_as_a_usage_error" },
      { file: "packages/sok/wailsv3/tests/debug_test.go", id: "TestQueryPrintsTheGoldenLinesOfEveryCase" },
      { file: "packages/sok/wailsv3/tests/debug_test.go", id: "TestQueryRefusesWhatBreaksTheContract" },
      { file: "packages/sok/wailsv3/tests/debug_test.go", id: "TestQueryRefusesAnInvalidFlagValueAsAUsageError" },
      { file: "packages/workbench/test/debug-timeline.test.mjs", id: "the text line of each golden page is the line that the implementations of sok print" },
    ],
    expected: "The command sok debug query prints the text lines of one page of the query over the event files of a configuration directory with the same filter and order as the debug view, and both implementations print the same lines for the golden files.",
    levels: ["unit"],
  },
  {
    id: "F151.5",
    implementation: [
      { file: "packages/workbench/debug-state.js", symbol: "export function compareStates" },
      { file: "packages/workbench/debug-ui.js", symbol: "export async function showDebugState" },
    ],
    tests: [
      { file: "packages/workbench/test/debug-state.test.mjs", id: "a comparison lists the paths whose values differ, including paths present in one file" },
      { file: "packages/workbench/test/debug-state-ui.test.mjs", id: "a state file is shown as a tree and two state files are compared" },
    ],
    expected: "The debug view shows a state file as a tree, compares two state files by the paths whose values differ, and rejects a file that is not a state with its name and what was found.",
    levels: ["unit"],
  },
  {
    id: "F151.4.2",
    implementation: [
      { file: "packages/workbench/debug-ui.js", symbol: "export function selectDebugRow" },
      { file: "packages/workbench/debug-ui.js", symbol: "export async function saveDebugRows" },
    ],
    tests: [
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "rows are selected and unselected by index, and the status reports the count and the warning" },
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "the selected rows are saved in timeline order as one text, also those that the filter hides" },
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "a cancelled save panel leaves no error and an empty selection is refused with an error" },
    ],
    expected: "The debug timeline selects and unselects rows, reports the number of selected rows and the warning that a saved file can hold typed text, saves the text lines of the selected rows in timeline order, treats a cancelled save panel as no error, and refuses an empty selection with an error.",
    levels: ["unit"],
  },
  {
    id: "F151.3",
    implementation: [
      { file: "packages/workbench/debug-timeline.js", symbol: "export function queryOf" },
      { file: "packages/workbench/debug-ui.js", symbol: "export function filterDebugTimeline" },
    ],
    tests: [
      { file: "packages/workbench/test/debug-timeline.test.mjs", id: "the request of the query leaves the open members out and turns the UTC times into microseconds" },
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "the filter asks the host for the newest page again with the members of the filter" },
    ],
    expected: "The debug timeline filters rows by event name, surface, session, correlation identifier and UTC time range through the query of the host, and rejects an invalid value with an error.",
    levels: ["unit"],
  },
  {
    id: "F151.1",
    implementation: [
      { file: "packages/workbench/debug-timeline.js", symbol: "export function mergeRows" },
      { file: "packages/workbench/debug-ui.js", symbol: "export function showDebugTimeline" },
    ],
    tests: [
      { file: "packages/workbench/test/debug-timeline.test.mjs", id: "rows are ordered by the key of the query: time, then role, then boot, then seq, and each row once" },
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "the timeline asks for the newest page and shows it oldest first with the status of the pages" },
    ],
    expected: "The debug view shows the events of the event files as a timeline of rows in time order with level, layer and text filters, and shows the error of a file that breaks the event structure with its name and line.",
    levels: ["unit"],
  },
  {
    id: "F151.2.3",
    implementation: [
      { file: "packages/workbench/debug-timeline.js", symbol: "export function isEventFile" },
      { file: "packages/workbench/debug-ui.js", symbol: "export async function followDebugTimeline" },
      { file: "packages/workbench/page-log.js", symbol: "\"logQuery\"" },
    ],
    tests: [
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "a changed event file adds the rows after the tail in time order, also a row with an earlier clock, and keeps the filter and the selection" },
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "following pages through the rows that grew until none is left and asks again from the first tail" },
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "stopping follows no more queries and resuming asks for what grew while stopped" },
      { file: "packages/workbench/test/debug-timeline-ui.test.mjs", id: "a query that fails while following stops following and is shown with its file and line" },
      { file: "packages/workbench/test/page-log.test.mjs", id: "every host call is the event page.call with its name, arguments, duration and outcome, except the calls of the log itself and the queries of the debug timeline" },
    ],
    expected: "The debug timeline asks for the rows after the tail of the query when a debug-log-changed notice reports a write, adds them in time order while keeping the filter and the selection, stops and resumes following by a command, stops following with an error for a query that fails, and its queries are not recorded as page calls.",
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
      { file: "packages/window-check/event-log.mjs", symbol: "export function readEventErrors" },
      { file: "packages/workbench/report-record.js", symbol: "export function recordOf" },
    ],
    tests: [
      { file: "packages/window-check/test/session-cleanup.test.mjs", id: "a record event of level error fails the check as the line of the text form unless it is declared" },
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
      { file: "packages/host/wailsv3/tests/application_log_test.go", id: "TestLogErrorWritesAnErrorEventToTheEventLog" },
      { file: "packages/host/tauriv2/tests/application_log_test.rs", id: "log_error_writes_an_error_event_to_the_event_log" },
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
      { file: "packages/host/tauriv2/tests/private_files_test.rs", id: "write_private_file_creates_an_owner_only_file_and_replaces_its_contents" },
      { file: "scripts/test/windows-build-check.test.mjs", id: "the Windows build check compiles the Go host source in the default and diagnostics builds" },
    ],
    expected: "Both hosts create owner-only files and directories only through the platform operations, Darwin gives them modes 0700 and 0600, the process lock has mode 0600 in both hosts, and the Windows implementation compiles and returns its not-implemented errors.",
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
      { file: "packages/host/wailsv3/go.mod", symbol: "replace github.com/wailsapp/wails/v3 => github.com/min-0-max/wails/v3" },
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
      { file: "packages/workbench/test/picker-layer.test.mjs", id: "the icon and the name of a heading and of an item carry declared dom names and the headings are reported" },
      { file: "packages/workbench/test/picker-columns.test.mjs", id: "the icon and the name of a heading and of its items share one column at every depth" },
      { file: "e2e/space-apps.test.mjs", id: "a fullscreen card lists the apps of the space by card and switches to a picked one" },
    ],
    expected: "A fullscreen card lists the apps of the space by card and moves fullscreen to a picked tab's card.",
    levels: ["unit", "application"],
  },
  {
    id: "F139",
    implementation: [
      { file: "packages/workbench/picker-layer.js", symbol: "export function pickerColumns" },
    ],
    tests: [
      { file: "packages/workbench/test/picker-layer.test.mjs", id: "the columns of the headings and the items are measured relative to the picker" },
      { file: "packages/workbench/test/picker-columns.test.mjs", id: "the icon and the name of a heading and of its items share one column at every depth" },
      { file: "e2e/space-apps.test.mjs", id: "a fullscreen card lists the apps of the space by card and switches to a picked one" },
    ],
    expected: "The icon and the name of a group heading and of its items start at the same x, measured in the running application through the status core.picker.",
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
      { file: "packages/window-check/test/session-cleanup.test.mjs", id: "a recording folder that the check left fails the check and is preserved" },
    ],
    expected: "A window check that leaves a recording folder fails and preserves it when the check or cleanup fails.",
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
      { file: "packages/window-check/test/recording.test.mjs", id: "a recording whose stop fails fails finalization, sends no second stop and preserves its folder" },
      { file: "e2e/window-first-frames.test.mjs", id: "a new window shows its complete first screen from its first frame" },
    ],
    expected: "A window check sends one stop for each recording and keeps that stop's error; failed recordings remain available for diagnosis.",
    levels: ["unit", "application"],
  },
  {
    id: "F93",
    implementation: [
      { file: "Makefile", symbol: "node scripts/go-tests.mjs" },
      { file: "scripts/go-tests.mjs", symbol: "has no test files built with tags" },
    ],
    tests: [
      { file: "scripts/test/go-repeat.test.mjs", id: "make go-repeat fails a package whose test files are not built" },
      { file: "scripts/test/go-repeat.test.mjs", id: "make go-repeat passes a pattern whose tested package passed while a support package has no test files" },
      { file: "scripts/test/go-repeat.test.mjs", id: "make go-repeat fails a run in which no test matched" },
      { file: "scripts/test/rust-repeat.test.mjs", id: "make rust-repeat passes its features to every cargo test call" },
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
      { file: "packages/host/wailsv3/src/endpoint.go", symbol: "already owned by a live process" },
      { file: "packages/host/tauriv2/src/endpoint.rs", symbol: "already owned by a live process" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/endpoint_test.go", id: "TestEndpointRefusesAHeldLockWithAnotherForm" },
      { file: "packages/host/tauriv2/tests/endpoint_test.rs", id: "a_held_lock_with_another_form_is_refused_and_kept" },
    ],
    expected: "Both hosts refuse a held process.lock whose contents are not the current form, with the same text.",
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
    id: "F250",
    implementation: [
      { file: "packages/plugin-api/operation.js", symbol: "export function createOperationCids" },
      { file: "packages/plugin-api/view.js", symbol: "beginOperation" },
      { file: "packages/workbench/view-calls.js", symbol: "export async function answerViewCall" },
      { file: "packages/workbench/exposure.js", symbol: "const commandRequest" },
      { file: "packages/host/wailsv3/src/documents.go", symbol: "func ViewCallEvent" },
      { file: "packages/host/tauriv2/src/documents.rs", symbol: "fn cause_cids_of" },
    ],
    tests: [
      { file: "packages/plugin-api/test/view-operations-contract.test.mjs", id: "view.operation.begin-logs-first-event-and-carries-cids" },
      { file: "packages/plugin-api/test/view-commands-contract.test.mjs", id: "view.commands.run-passes-cids-to-handler" },
      { file: "packages/plugin-api/test/exposure.test.mjs", id: "a command run hands the cids of its cause to the handler as its context, and refuses a list a line cannot hold" },
      { file: "packages/workbench/test/view-calls.test.mjs", id: "a call that carries the cids of its cause hands them to the command of its plugin" },
      { file: "packages/workbench/test/view-calls.test.mjs", id: "a core command call that carries the cids of its cause hands them to runCore" },
      { file: "packages/workbench/test/app-update.test.mjs", id: "the release page of a command that carries the cids of its cause opens it with those cids" },
      { file: "packages/host/wailsv3/src/surfaces_test.go", id: "TestViewCallCarriesTheCidsOfItsCause" },
      { file: "packages/host/tauriv2/tests/documents_test.rs", id: "view_call_request_carries_the_cids_of_its_cause_and_refuses_invalid_ones" },
    ],
    expected: "A view starts an operation whose identifiers are in the page form and whose first event carries them, and a command call of the view reaches its plugin command or its core command with those identifiers, which the core command passes to its host call; both hosts forward the cids of a view call and refuse a list that a log line cannot hold.",
    levels: ["unit"],
  },
  {
    id: "V5",
    implementation: [{ file: "packages/soksak/scripts/check-breaks.mjs", symbol: "run" }],
    tests: [{ file: "scripts/test/soksak-scripts.test.mjs", id: "break inventory lists only requested, known entries" }],
    expected: "The break audit runs each test file with a 20-second deadline in isolated parallel copies, reports progress, and catches all 142 declared breaks without an aggregate timeout or silent result.",
    levels: ["unit"],
  },
  {
    id: "F239-38",
    implementation: [
      { file: "packages/sok/wailsv3/src/log_policy.go", symbol: '"host.test.start", "host.test.end"' },
      { file: "packages/sok/tauriv2/src/event_log.rs", symbol: '"host.test.start"' },
      { file: "packages/host/wailsv3/src/test_mark.go", symbol: "func EmitTestMark" },
      { file: "packages/host/tauriv2/src/test_mark.rs", symbol: "pub fn emit_test_mark" },
    ],
    tests: [
      { file: "packages/host/wailsv3/tests/test_mark_test.go", id: "TestATestMarkIsAnEventAndTheReplyNamesItsPosition" },
      { file: "packages/host/wailsv3/tests/test_mark_test.go", id: "TestATestMarkIsStoredWhenLifecycleIsOff" },
      { file: "packages/host/tauriv2/tests/test_mark_test.rs", id: "a_test_mark_is_an_event_and_the_reply_names_its_position" },
      { file: "packages/host/tauriv2/tests/test_mark_test.rs", id: "a_test_mark_is_stored_when_lifecycle_is_off" },
    ],
    expected: "Both hosts store and flush host.test.start and host.test.end at info under lifecycle=error and lifecycle=off, return their event positions, and still gate ordinary lifecycle/info records.",
    levels: ["unit"],
  },
  {
    id: "F239-39",
    implementation: [
      { file: "packages/workbench/exposure.js", symbol: "onRegistrationChange(listener)" },
      { file: "packages/workbench/sidebar-sections.js", symbol: "entry.declared?.reconcile()" },
    ],
    tests: [{ file: "packages/workbench/test/sidebar-sections.test.mjs", id: "a declared section selects and pulls a host that registers after the section is drawn" }],
    expected: "A drawn declared section reselects and pulls its host status source after registration changes, and the same test verifies repeated registration, source changes, and cleanup.",
    levels: ["unit"],
  },
  {
    id: "F239-40",
    implementation: [
      { file: "packages/host/wailsv3/src/plugin_host_channel.go", symbol: "func pluginHostErrorText" },
      { file: "packages/host/tauriv2/src/plugin_host_channel.rs", symbol: "fn plugin_host_error_text" },
    ],
    tests: [
      { file: "packages/host/wailsv3/src/plugin_host_channel_test.go", id: "TestPluginHostViewErrorNamesItsPluginOnce" },
      { file: "packages/host/wailsv3/src/plugin_host_test.go", id: "TestViewErrorWithoutAReasonIsRefused" },
      { file: "packages/host/tauriv2/src/plugin_host_channel_test.rs", id: "a_view_error_names_its_plugin_once" },
      { file: "packages/host/tauriv2/src/plugin_host_channel_test.rs", id: "a_view_error_without_a_reason_is_refused" },
    ],
    expected: "Both host channels include the known plugin identity once in a view.error reason and refuse an empty reason; the JavaScript source of a generic Script error remains unknown.",
    levels: ["unit"],
  },
  {
    id: "F239-40-1",
    implementation: [{ file: "packages/host/wailsv3/src/sidecars.go", symbol: "func (c *Sidecars) processPersistent" }],
    tests: [{ file: "packages/host/wailsv3/src/sidecar_reply_test.go", id: "TestAZeroHelloTimeoutIsRefusedBeforeAServiceStarts" }],
    expected: "The Wails persistent-service start refuses a zero HelloTimeout before starting a service, and its owning test calls the current processPersistent function signature and checks that error.",
    levels: ["unit"],
  },
  {
    id: "F263",
    implementation: [
      { file: "packages/workbench/host.js", symbol: "while (reply !== themeReply)" },
      { file: "packages/workbench/host.js", symbol: 'return tell("syncSurfaces", request)' },
    ],
    tests: [
      { file: "packages/workbench/test/host-theme-placement.test.mjs", id: "view placement waits for the latest host theme reply" },
      { file: "packages/workbench/test/host-theme-placement.test.mjs", id: "view placement rechecks the theme after its reply continuation" },
      { file: "packages/workbench/test/host-theme-placement.test.mjs", id: "a failed theme reply refuses view placement and reports the host error" },
      { file: "packages/workbench/test/projects-switch.test.mjs", id: "the start document draws the project synchronously while the host theme reply is pending" },
    ],
    expected: "View placement waits for the latest host theme reply and refuses placement when that reply fails, while the start document keeps its synchronous first DOM draw.",
    levels: ["unit"],
  },
  {
    id: "F264",
    implementation: [
      { file: "scripts/check-versions.mjs", symbol: 'export const RELEASE = "0.0.21"' },
      { file: "scripts/check-versions.mjs", symbol: 'export const LATEST_PUBLISHED = "0.0.20"' },
    ],
    tests: [
      { file: "scripts/test/versions.test.mjs", id: "the development contract has a distinct identity from the latest published release" },
      { file: "scripts/test/versions.test.mjs", id: "every declared workspace version is the release candidate" },
      { file: "scripts/test/versions.test.mjs", id: "workspace Cargo.lock package versions match the release candidate" },
    ],
    expected: "The development release candidate is 0.0.21, distinct from latest published 0.0.20, and the tracked version tests audit workspace manifests and Cargo.lock against that candidate.",
    levels: ["unit"],
  },
];

// Generated output is checked for agreement with its source and is not counted as an independent implementation.
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
const IMPORT_SPECIFIER = /(?:from\s*|import\s*\(|require(?:\.resolve)?\s*\(|import\s+)["'`]([^"'`]+)["'`]/g;
// The bare form of a reference is the argument of require.resolve; other bare names are not module references.
const PACKAGE_REFERENCE = /require\.resolve\(\s*["'`](@soksak\/[a-z0-9][a-z0-9-]*(?:\/[^"'`\s]+)?)["'`]/g;

function ownerFor(file) {
  return OWNER_ROOTS.find(([root]) => file.startsWith(root))?.[1] ?? null;
}

function isDeclaration(file) {
  return DECLARATION_FILE.test(file);
}

/**
 * The packages of the checkout and of the declared repositories, by their exact names (decision D3, rules 2, 3 and 5):
 * the folder (relative to the checkout for core packages, absolute for declared repositories), the owner, and the
 * exports map of the package.json. Core holds no list of the packages of other repositories.
 */
export function packageIndex(root = ROOT) {
  const index = new Map();
  for (const file of execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0")) {
    if (!/(^|\/)package\.json$/.test(file)) continue;
    const manifest = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
    if (typeof manifest.name !== "string") continue;
    const dir = dirname(file);
    index.set(manifest.name, { dir: dir === "." ? "" : dir, owner: ownerFor(file) ?? "core", exports: manifest.exports });
  }
  // The core-served prefix (@soksak/shared) has no package.json; core serves every subpath of it.
  for (const name of corePackageNames(root)) {
    if (!index.has(name)) index.set(name, { dir: "", owner: "core", exports: { "./*": "./*" } });
  }
  for (const item of components(root)) {
    if (item.kind === "core") continue;
    index.set(item.name, { dir: item.dir, owner: item.kind, exports: JSON.parse(readFileSync(join(item.dir, "package.json"), "utf8")).exports });
  }
  return index;
}

/** The subpath following the first two path segments, or "" for the package itself. */
function packageReference(value) {
  const [scope, name, ...rest] = value.split("/");
  return { base: `${scope}/${name}`, subpath: rest.join("/") };
}

/** Whether the exports map of a package lists the subpath (`./x`), exactly or through one `*` pattern. */
function exported(exportsMap, subpath) {
  if (!exportsMap || typeof exportsMap !== "object") return false;
  return Object.keys(exportsMap).some((key) => {
    if (!key.startsWith("./")) return false;
    const star = key.indexOf("*");
    if (star < 0) return key === subpath;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    return subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length;
  });
}

/** The declared package that holds the file: the longest folder of the index that contains it. */
function packageOfFile(file, index) {
  let found = null;
  for (const [name, entry] of index) {
    if (entry.dir && file.startsWith(`${entry.dir}/`) && (!found || entry.dir.length > found.dir.length)) {
      found = { name, dir: entry.dir };
    }
  }
  return found?.name ?? null;
}

function ownerReferences(source) {
  const references = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) references.push({ value: match[1], private: PRIVATE_SEGMENT.test(match[1]) });
  for (const match of source.matchAll(PACKAGE_REFERENCE)) {
    if (!references.some(({ value }) => value === match[1])) references.push({ value: match[1], private: false });
  }
  return references;
}

/**
 * Checks the owner boundaries. Only declaration files may connect a plugin and a sidecar.
 * This function is not a behavior test: it mechanically decides on the forbidden references in implementation and test sources.
 * The apps and e2e consume the public contract, so they may use other public packages,
 * but the private, src and tests paths are forbidden for every owner.
 */
export function auditOwnership(files, readSource = (file) => readFileSync(`${ROOT}${file}`, "utf8"), index = packageIndex()) {
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
    const kind = `${owner}${testFile ? " test" : " implementation"}`;
    for (const reference of ownerReferences(source)) {
      const value = reference.value;
      if (value.startsWith("@soksak/")) {
        const { base, subpath } = packageReference(value);
        const entry = index.get(base);
        // An undeclared name is a finding in every owner: core names only declared packages (decision D3, rule 2).
        if (!entry) {
          errors.push(`${file}: ${kind} names undeclared package ${base}`);
          continue;
        }
        // A subpath is public only when the package lists it in its exports map; a package without one exposes none.
        // A package reads its own subpaths without the map.
        if (subpath && packageOfFile(file, index) !== base && !exported(entry.exports, `./${subpath}`)) {
          errors.push(`${file}: ${kind} reads private path ${value}`);
          continue;
        }
        if (entry.owner === "core" || entry.owner === owner) continue;
        if (owner === "application" || owner === "contract") continue;
        errors.push(`${file}: ${kind} names ${entry.owner} implementation ${value}`);
        continue;
      }
      const pathOwner = OWNER_ROOTS.find(([root]) => value.includes(root))?.[1] ?? null;
      if (!pathOwner) continue;
      if (reference.private && pathOwner !== owner) {
        errors.push(`${file}: ${kind} reads private path ${value}`);
        continue;
      }
      if (pathOwner === owner || pathOwner === "core") continue;
      if (owner === "application" || owner === "contract") continue;
      errors.push(`${file}: ${kind} names ${pathOwner} implementation ${value}`);
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
    if (!file.startsWith(scope) || !file.endsWith(".rs") || /(^|\/)(test|tests|benches)\//.test(file)) continue;
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

// There is no fixed root per language: every other language of a package is found too.
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
    const isTest = /(^|\/)(test|tests|benches)\//.test(file) || /(^|\/)e2e\//.test(file) || /[._]test\.(mjs|js|cjs|ts|go|rs|m|mm)$/.test(file);
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

// Only the patterns *, **, and ? that declarations use are expanded.
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
const NON_CAPABILITY_COMPLETIONS = new Set(["F205", "F252","F13", "F25", "G1.4-2", "R2", "R4", "R6", "V3", "F96", "F99", "F99.1", "F99.2", "F99.3", "F99.4", "F106", "F108", "F194", "F206", "F211", "F214-1", "F215", "F216", "F243", "F247", "F253", "F256", "F257-2", "F261"]);

// Completed capabilities whose implementation and tests are in a plugin or sidecar repository: those that
// moved there (R1-5, docs/spec/plugins.md#repositories) and changes made there (F98, F100, F101, F109, and F203, the service exits of vt item S66) and the window checks of plugins (F110). Core cannot read
// those repositories, so they have no link here and each repository checks its own evidence.
const MOVED_COMPLETIONS = new Set(["F0.3", "F1.4", "F2.1-1", "F2.10", "F2.1", "F2.4-1", "F2.4", "F2.5", "F2.8", "F2.9", "F2", "F3", "F6.3-10", "F6.6-1", "F6.6-2", "F7.14", "F7.15", "F7.16", "F7.17", "F7", "G1.2", "F18", "F19", "F98", "F100", "F101", "F109", "F110", "F203", "F210"]);

// Completed capabilities whose implementation a later item removed: F68 wrote the WebKit child record, which F196.22
// removed with the start that ended the recorded processes.
// F60, F91, F114 and F116 wrote the module mount and dispose of a surface, which F212.11-2b removes with the module mount; their
// tests and symbols are removed with it.
const REMOVED_COMPLETIONS = new Set(["F68", "F60", "F91", "F114", "F116"]);

export function auditCompletedFeatureLinks(features, checklistSource = readFileSync(`${ROOT}docs/features.md`, "utf8")) {
  const linked = new Set(features.map((feature) => feature.id));
  const completed = [...checklistSource.matchAll(/^- \[o\] ([A-Z][A-Z0-9.-]*) —/gm)].map((match) => match[1]);
  return completed
    .filter((id) => !NON_CAPABILITY_COMPLETIONS.has(id) && !MOVED_COMPLETIONS.has(id) && !REMOVED_COMPLETIONS.has(id) && !linked.has(id))
    .map((id) => `${id}: completed capability has no feature link`);
}

// The current inventory counts are recorded in the sentence of the operations document that states the current state. The evidence of a completed checklist item is not changed.
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
  // A record does not state a commit id (AGENTS.md Documentation). Evidence points to its build by checklist ID.
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
