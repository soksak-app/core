import assert from "node:assert/strict";
import test from "node:test";
import { auditHostParity, auditMenuTables, goMenuTables, rustMenuTables, snake, specMenuTables } from "../check-host-parity.mjs";

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
});

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
  assert.deepEqual(auditHostParity(changed), []);
});
