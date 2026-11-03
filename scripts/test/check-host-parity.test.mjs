import assert from "node:assert/strict";
import test from "node:test";
import { auditCommonOnlyKeys, auditHostParity, auditMenuTables, commonOnlyKeys, goMenuTables, rustHandlers, rustMenuTables, snake, specMenuTables } from "../check-host-parity.mjs";

// The base sources of the injection checks. Changing only one name in the real sources proves that each failure is produced mechanically.
const sources = () => ({
  tauriv2Runtime: 'const COMMAND = {\n  windowNew: "window_new",\n  overlayShow: "overlay_show",\n};',
  tauriv2Bindings: 'macro_rules! bindings {}\nbindings! {\n#[tauri::command]\nfn window_new() {}\n#[tauri::command(async)]\nasync fn overlay_show() {}\n}',
  wailsv3Runtime: 'const METHOD = {\n  windowNew: "WindowNew",\n  overlayShow: "OverlayShow",\n}',
  wailsv3HostSources: { "host.go": "func (h *Host) WindowNew(ctx context.Context) error { return nil }\nfunc (h *Host) OverlayShow(ctx context.Context) error { return nil }" },
  tauriv2EndpointSource: 'const METHODS: &[&str] = &[\n  "windows.list",\n];\nconst DIAGNOSTICS: &[&str] = &[\n  "diagnostics.fixture",\n];',
  wailsv3EndpointSource: 'var endpointMethods = map[string]endpointMethod{\n  "windows.list": nil,\n}\nvar subscriptionMethods = map[string]subscriptionMethod{}\nvar diagnosticSubscriptions = map[string]subscriptionMethod{}',
  wailsv3DiagnosticsSource: 'func init() {\n  diagnosticMethods["diagnostics.fixture"] = nil\n}',
  hostContractSpec: specFixture,
  tauriv2MenuSource: rustMenuFixture,
  wailsv3MenuSource: goMenuFixture,
  hostsSpec: hostsFixture,
  endpointSpec: endpointFixture,
  tauriv2WorkspaceSource: 'const COMMON_ONLY: [&str; 2] = ["projectOpening", "textSize"];',
  wailsv3WorkspaceSource: 'var commonOnly = []string{"projectOpening", "textSize"}',
  browserStorageSource: 'const COMMON_ONLY = Object.freeze(["projectOpening", "textSize"]);',
  workbenchSettingsSource: 'const COMMON_ONLY = Object.freeze(["projectOpening", "textSize"]);',
});

const endpointFixture = `## Diagnostic builds

| Method | Params | Purpose |
| --- | --- | --- |
| \`diagnostics.fixture\` | \`{window}\` | fixture |

## Clients`;

// Adds a row of the diagnostic builds table before the next section.
const withDiagnosticRow = (endpointSpec, method) => endpointSpec.replace("\n\n## Clients", `\n| \`${method}\` | \`{window}\` | ${method} |\n\n## Clients`);

const hostsFixture = `## Allowed differences

| ID | Wails | Tauri | Reason |
| --- | --- | --- | --- |
| H1 | none | \`build.rs\` | file difference |
| E1 | \`diagnostics.heap.profile\` | none | endpoint method difference |

## Process lifecycle`;

const specFixture = `## Application menu

Menus:

| id | ko | en |
|---|---|---|
| app | (the application name) | (the application name) |
| file | 파일 | File |

Items:

| menu | id | source | ko | en | key |
|---|---|---|---|---|---|
| file | close-window | title | 윈도우 닫기 | Close Window | cmd+w |

## Contract cases`;

const rustMenuFixture = 'pub const MENUS: &[(&str, &str, &str)] = &[\n    ("app", "", ""),\n    ("file", "파일", "File"),\n];\npub const ITEMS: &[(&str, &str, &str, &str, &str, &str)] = &[\n    ("file", "close-window", "title", "윈도우 닫기", "Close Window", "cmd+w"),\n];';

const goMenuFixture = 'var menuTable = []struct{ id, ko, en string }{\n\t{"app", "", ""},\n\t{"file", "파일", "File"},\n}\nvar itemTable = []struct{ menu, id, source, ko, en, key string }{\n\t{"file", "close-window", "title", "윈도우 닫기", "Close Window", "cmd+w"},\n}';

test("equal surfaces pass with no failure", () => {
  assert.deepEqual(auditHostParity(sources()), []);
});

test("a call name that exists on one host only fails", () => {
  const changed = sources();
  changed.tauriv2Runtime = changed.tauriv2Runtime.replace('windowNew: "window_new",', 'windowNew: "window_new",\n  linkOpen: "link_open",');
  changed.tauriv2Bindings = changed.tauriv2Bindings.replace('fn window_new() {}', 'fn window_new() {}\n#[tauri::command]\nfn link_open() {}');
  assert.deepEqual(auditHostParity(changed), ["tauriv2 host.call(link_open) does not exist on wailsv3"]);
});

test("a call name without its host implementation fails", () => {
  for (const [label, changed] of [
    ["tauriv2", () => { const next = sources(); next.tauriv2Bindings = next.tauriv2Bindings.replace("#[tauri::command(async)]\nasync fn overlay_show() {}", ""); return next; }],
    ["wailsv3", () => { const next = sources(); next.wailsv3HostSources["host.go"] = next.wailsv3HostSources["host.go"].replace("func (h *Host) OverlayShow(ctx context.Context) error { return nil }", "func (h *Host) Removed(ctx context.Context) error { return nil }"); return next; }],
  ]) {
    const failures = auditHostParity(changed());
    assert.ok(failures.length >= 1 && failures.every((failure) => failure.includes(`${label} host.call(overlay_show) has no`)),
      `${label} wiring failure must name overlay_show, got ${JSON.stringify(failures)}`);
  }
});

test("an endpoint method that exists on one host only fails per build flavor", () => {
  const changed = sources();
  changed.tauriv2EndpointSource = changed.tauriv2EndpointSource.replace('"windows.list",', '"windows.list",\n  "windows.tiles",');
  assert.deepEqual(auditHostParity(changed), ['tauriv2 endpoint base methods has "windows.tiles" that wailsv3 does not']);
  const diagnosticOnly = sources();
  diagnosticOnly.wailsv3DiagnosticsSource = diagnosticOnly.wailsv3DiagnosticsSource.replace(
    'diagnosticMethods["diagnostics.fixture"] = nil',
    'diagnosticMethods["diagnostics.fixture"] = nil\n  diagnosticMethods["diagnostics.ticks"] = nil');
  diagnosticOnly.endpointSpec = withDiagnosticRow(diagnosticOnly.endpointSpec, "diagnostics.ticks");
  assert.deepEqual(auditHostParity(diagnosticOnly), ['wailsv3 endpoint diagnostics methods has "diagnostics.ticks" that tauriv2 does not']);
});

test("snake keeps concatenated capitals apart", () => {
  assert.equal(snake("ClipboardPersistPNG"), "clipboard_persist_png");
  assert.equal(snake("WindowNew"), "window_new");
});

test("menu tables that differ from the spec fail mechanically", () => {
  const spec = specMenuTables(specFixture);
  const changed = rustMenuFixture.replace('("file", "파일", "File")', '("file", "파일", "Files")');
  const failures = auditMenuTables(spec, rustMenuTables(changed), goMenuTables(goMenuFixture));
  assert.ok(failures.some((line) => line.includes("menu menus table differs")), JSON.stringify(failures));
  assert.deepEqual(auditMenuTables(spec, rustMenuTables(rustMenuFixture), goMenuTables(goMenuFixture)), []);
});

test("an endpoint method of one host passes only when the allowed differences declare it", () => {
  const changed = sources();
  changed.wailsv3DiagnosticsSource = changed.wailsv3DiagnosticsSource.replace("}", '  diagnosticMethods["diagnostics.heap.profile"] = nil\n}');
  changed.endpointSpec = withDiagnosticRow(changed.endpointSpec, "diagnostics.heap.profile");
  assert.deepEqual(auditHostParity(changed), []);
  changed.hostsSpec = changed.hostsSpec.replace(/\| E1 .*\n/, "");
  assert.deepEqual(auditHostParity(changed),
    ['wailsv3 endpoint diagnostics methods has "diagnostics.heap.profile" that tauriv2 does not']);
});

test("hyphenated diagnostic endpoint methods are read from both hosts", () => {
  const changed = sources();
  changed.tauriv2EndpointSource = changed.tauriv2EndpointSource.replace(
    '"diagnostics.fixture",', '"diagnostics.fixture",\n  "diagnostics.native.window-color-space",');
  changed.wailsv3DiagnosticsSource = changed.wailsv3DiagnosticsSource.replace(
    'diagnosticMethods["diagnostics.fixture"] = nil',
    'diagnosticMethods["diagnostics.fixture"] = nil\n  diagnosticMethods["diagnostics.native.window-color-space"] = nil');
  changed.endpointSpec = withDiagnosticRow(changed.endpointSpec, "diagnostics.native.window-color-space");
  assert.deepEqual(auditHostParity(changed), []);
});

test("a diagnostic method that the diagnostic builds table does not list fails", { timeout: 1000 }, () => {
  const changed = sources();
  changed.tauriv2EndpointSource = changed.tauriv2EndpointSource.replace('"diagnostics.fixture",', '"diagnostics.fixture",\n  "diagnostics.ticks",');
  changed.wailsv3DiagnosticsSource = changed.wailsv3DiagnosticsSource.replace(
    'diagnosticMethods["diagnostics.fixture"] = nil',
    'diagnosticMethods["diagnostics.fixture"] = nil\n  diagnosticMethods["diagnostics.ticks"] = nil');
  assert.deepEqual(auditHostParity(changed), [
    'tauriv2 diagnostic method "diagnostics.ticks" is not in the diagnostic builds table of the endpoint specification',
    'wailsv3 diagnostic method "diagnostics.ticks" is not in the diagnostic builds table of the endpoint specification',
  ]);
});

test("a method of the diagnostic builds table that no host declares fails", { timeout: 1000 }, () => {
  const changed = sources();
  changed.endpointSpec = withDiagnosticRow(changed.endpointSpec, "diagnostics.retired");
  assert.deepEqual(auditHostParity(changed), [
    'the diagnostic builds table of the endpoint specification lists "diagnostics.retired", which no host declares',
  ]);
});

test("rustHandlers reads a command that is generic over the runtime", { timeout: 1000 }, () => {
  const bindings = "\nbindings! {\n#[tauri::command]\nasync fn plugins_run<R: tauri::Runtime>(\n    app: AppHandle<R>,\n) -> Result<(), String> {}\n#[tauri::command]\nfn release(window: Window) -> Result<(), String> {}\n}\n";
  assert.deepEqual([...rustHandlers(bindings)], ["plugins_run", "release"]);
});

test("a common-only key that the workbench refuses and a host or the browser runtime accepts fails", { timeout: 1000 }, () => {
  const changed = { ...sources(), workbenchSettingsSource: 'const COMMON_ONLY = Object.freeze(["projectOpening", "textSize", "memorySaver"]);' };
  assert.deepEqual(auditHostParity(changed), [
    'tauriv2 common-only keys ["projectOpening","textSize"] differ from the common-only keys of the workbench ["memorySaver","projectOpening","textSize"]',
    'wailsv3 common-only keys ["projectOpening","textSize"] differ from the common-only keys of the workbench ["memorySaver","projectOpening","textSize"]',
    'browser common-only keys ["projectOpening","textSize"] differ from the common-only keys of the workbench ["memorySaver","projectOpening","textSize"]',
  ]);
});

test("the common-only keys of the hosts, the browser runtime and the workbench are read from their sources", { timeout: 1000 }, async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const keys = commonOnlyKeys({
    tauriv2WorkspaceSource: read("packages/host/tauriv2/src/workspace.rs"),
    wailsv3WorkspaceSource: read("packages/host/wailsv3/src/workspace.go"),
    browserStorageSource: read("apps/browser/runtime/browser-storage.js"),
    workbenchSettingsSource: read("packages/workbench/settings.js"),
  });
  assert.deepEqual(keys.workbench, ["projectOpening", "textSize", "memorySaver", "memorySaverDelay"]);
  assert.deepEqual(auditCommonOnlyKeys(keys), []);
});
