import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { allowedEndpointMethods, allowedPortMethods, auditCommonOnlyKeys, auditHostParity, auditMenuTables, auditPlatformCallers, auditPortMethods, commonOnlyKeys, goMenuTables, goPlatformMethods, goPortMethods, hostProductSources, libraryCrate, rustHandlers, rustMenuTables, rustPlatformMethods, rustPortMethods, snake, specMenuTables, withoutRustTestItems } from "../check-host-parity.mjs";

// The base sources of the injection checks. Changing only one name in the real sources proves that each failure is produced mechanically.
const sources = () => ({
  tauriv2Runtime: 'const COMMAND = {\n  windowNew: "window_new",\n  overlayShow: "overlay_show",\n};',
  tauriv2Bindings: 'macro_rules! bindings {}\nbindings! {\n#[tauri::command]\nfn window_new() {}\n#[tauri::command(async)]\nasync fn overlay_show() {}\n}',
  wailsv3Runtime: 'const METHOD = {\n  windowNew: "WindowNew",\n  overlayShow: "OverlayShow",\n}',
  mygoCallsSource: 'func hostCalls(h *host.Host, ctx context.Context) map[string]HostCall {\n\treturn map[string]HostCall{\n\t\t"windowNew": run(h.WindowNew),\n\t}\n}',
  wailsv3HostSources: { "host.go": "func (h *Host) WindowNew(ctx context.Context) error { return nil }\nfunc (h *Host) OverlayShow(ctx context.Context) error { return nil }" },
  tauriv2EndpointSource: 'const METHODS: &[&str] = &[\n  "windows.list",\n];\nconst DIAGNOSTICS: &[&str] = &[\n  "diagnostics.fixture",\n];',
  wailsv3EndpointSource: 'var endpointMethods = map[string]endpointMethod{\n  "windows.list": nil,\n}\nvar subscriptionMethods = map[string]subscriptionMethod{}\nvar diagnosticSubscriptions = map[string]subscriptionMethod{}',
  wailsv3DiagnosticsSource: 'func init() {\n  diagnosticMethods["diagnostics.fixture"] = nil\n}',
  hostContractSpec: specFixture,
  tauriv2MenuSource: rustMenuFixture,
  wailsv3MenuSource: goMenuFixture,
  hostsSpec: hostsFixture,
  endpointSpec: endpointFixture,
  tauriv2DeclarationSource: '{"settings": {"commonOnly": ["projectOpening", "textSize"]}}',
  wailsv3DeclarationSource: '{"settings": {"commonOnly": ["projectOpening", "textSize"]}}',
  workbenchDeclarationSource: '{"settings": {"commonOnly": ["projectOpening", "textSize"]}}',
  tauriv2PlatformSource: rustPlatformFixture,
  wailsv3PlatformSource: goPlatformFixture,
  tauriv2ProductSources: platformSources().tauriv2,
  wailsv3ProductSources: platformSources().wailsv3,
  tauriv2ApplicationSources: applicationSources().tauriv2,
  goApplicationSources: applicationSources().wailsv3,
  tauriv2Crate: tauriv2Crate,
  tauriv2PortSource: rustPortFixture,
  wailsv3PortSource: goPortFixture,
});

// The platform interfaces of the two hosts and host sources outside the platform folder that call each method; in Go one method is passed
// as a method value.
const platformSources = () => ({
  tauriv2: { "surfaces.rs": "pub fn sync(p: &dyn Platform) {\n    p.set_core_root(resolve)?;\n    let surface = p.create_surface(main)?;\n    p.place_webview(&view, frame)?;\n}" },
  wailsv3: { "host.go": "package host\n\nfunc Run() {\n\tsystem.SetCoreRoot(resolve)\n\tsurface, err := system.CreateSurface(window)\n\tapplication.InvokeSync(system.AnswerQuitRequests)\n}" },
});

// The applications that link each host: their main functions call the host functions of the platform sources.
const applicationSources = () => ({
  tauriv2: { "apps/tauriv2/src/main.rs": "fn main() {\n    soksak_host_tauriv2::surfaces::sync(platform);\n}" },
  wailsv3: { "apps/wailsv3/src/main.go": "package main\n\nfunc main() {\n\thost.Run()\n}" },
});

// The library crate of the Tauri host: its root source and the name that applications use.
const tauriv2Crate = { root: "host.rs", name: "soksak_host_tauriv2" };

// Audits the platform callers of both hosts.
const platformFailures = (sources, applications = applicationSources()) => [
  ...auditPlatformCallers("tauriv2", rustPlatformMethods(rustPlatformFixture), sources.tauriv2,
    { language: "rust", crate: tauriv2Crate, applications: applications.tauriv2 }),
  ...auditPlatformCallers("wailsv3", goPlatformMethods(goPlatformFixture), sources.wailsv3,
    { language: "go", applications: applications.wailsv3 }),
];

const rustPlatformFixture = `pub trait CoreRootHost {
    fn set_core_root(&self, resolve: CoreRootResolver) -> Result<(), String>;
}

pub trait Platform: CoreRootHost + Send + Sync {
    /// Creates a surface.
    fn create_surface(&self, main: Handle) -> Result<Handle, String>;
    fn place_webview(
        &self,
        view: &PlatformWebview,
        frame: Frame,
    ) -> Result<(), String>;
}`;

const goPlatformFixture = `type CoreRootHost interface {
	SetCoreRoot(resolve CoreRootResolver) error
}

type Platform interface {
	CoreRootHost
	// CreateSurface creates a surface.
	CreateSurface(window unsafe.Pointer) (unsafe.Pointer, error)
	AnswerQuitRequests()
}`;

const endpointFixture = `## Diagnostic builds

| Method | Params | Purpose |
| --- | --- | --- |
| \`diagnostics.fixture\` | \`{window}\` | fixture |

## Clients`;

// Adds a row of the diagnostic builds table before the next section.
const withDiagnosticRow = (endpointSpec, method) => endpointSpec.replace("\n\n## Clients", `\n| \`${method}\` | \`{window}\` | ${method} |\n\n## Clients`);

const hostsFixture = `## Allowed differences

### Language table

| ID | Go | Rust | Reason |
| --- | --- | --- | --- |
| H1 | none | \`build.rs\` | file difference |
| E1 | \`diagnostics.heap.profile\` | none | endpoint method difference |
| P1 | \`Framework.Step\` | none | port method difference |
| P2 | none | \`Frontend.scale_factor\` | port method difference |

### Framework table

| ID | Wails | Tauri | mygo | Reason |
| --- | --- | --- | --- | --- |
| H9 | \`tests/framework_log_test.go\` | none | none | file difference |
| B1 | \`overlayShow\` | \`overlayShow\` | none | calls that a mygo window does not have |
| B2 | none | none | \`mygoOwn\` | a call that only a mygo window has |

## Process lifecycle`;

// The framework ports of the two languages: the methods that both have, and the two that rows P1 and P2 of the fixture list.
const goPortFixture = 'type Framework interface {\n\t// ApplicationName names it.\n\tApplicationName() string\n\tStep(task func())\n\tWindows() []Frontend\n}\n\ntype Frontend interface {\n\tNativeWindow() unsafe.Pointer\n\tIsMaximized() bool\n}\n';
const rustPortFixture = 'pub trait Framework: Send + Sync {\n    /// Names it.\n    fn application_name(&self) -> &\'static str;\n    fn windows(&self) -> Vec<Arc<dyn Frontend>>;\n}\n\npub trait Frontend: Send + Sync {\n    fn native_window(&self) -> Result<*mut c_void>;\n    fn is_maximized(&self) -> Result<bool>;\n    fn scale_factor(\n        &self,\n    ) -> Result<f64>;\n}\n';

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

test("a name of hostCalls without a handler fails", () => {
  const changed = sources();
  changed.mygoCallsSource = changed.mygoCallsSource.replace('"windowNew": run(h.WindowNew),', '"windowNew": run(h.WindowNew),\n\t\t"overlayShow": run(h.OverlayShow),\n\t\t"absent": run(h.Absent),');
  assert.deepEqual(auditHostParity(changed), ["mygo host.call(absent) does not exist on wailsv3", "mygo host.call(absent) has no Host method", "mygo host.call(overlay_show) is listed as absent on mygo"]);
});

test("a call that only hostCalls names passes when a row B lists it in the column of mygo", () => {
  const changed = sources();
  changed.mygoCallsSource = changed.mygoCallsSource.replace('"windowNew": run(h.WindowNew),', '"windowNew": run(h.WindowNew),\n\t\t"mygoOwn": run(h.WindowNew),');
  assert.deepEqual(auditHostParity(changed), []);
  changed.hostsSpec = changed.hostsSpec.replace('\`mygoOwn\`', 'none');
  assert.deepEqual(auditHostParity(changed), ["mygo host.call(mygo_own) does not exist on wailsv3"]);
});

test("a call of wailsv3 that hostCalls does not name fails unless a row B lists it", () => {
  const changed = sources();
  changed.mygoCallsSource = changed.mygoCallsSource.replace('"windowNew": run(h.WindowNew),', '');
  assert.deepEqual(auditHostParity(changed), ["wailsv3 host.call(window_new) does not exist on mygo"]);
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

test("an endpoint method of one language passes only when the language table declares it", { timeout: 1000 }, () => {
  const tables = "## Allowed differences\n\n### Language table\n\n| ID | Go | Rust | Reason |\n| --- | --- | --- | --- |\n"
    + "| E1 | `diagnostics.heap.profile` | none | Reason |\n\n### Framework table\n\n| ID | Wails | Tauri | Reason |\n"
    + "| --- | --- | --- | --- |\n| H3 | `src/bridge.js` | none | Reason |\n\n## Memory pressure\n";
  const allowed = allowedEndpointMethods(tables);
  assert.deepEqual([...allowed.go], ["diagnostics.heap.profile"]);
  assert.deepEqual([...allowed.rust], []);
});

test("the methods of the framework ports are read from the Go interfaces and the Rust traits", { timeout: 1000 }, () => {
  assert.deepEqual(Object.fromEntries(goPortMethods(goPortFixture)), {
    Framework: ["ApplicationName", "Step", "Windows"], Frontend: ["NativeWindow", "IsMaximized"],
  });
  assert.deepEqual(Object.fromEntries(rustPortMethods(rustPortFixture)), {
    Framework: ["application_name", "windows"], Frontend: ["native_window", "is_maximized", "scale_factor"],
  });
  assert.throws(() => goPortMethods("type Framework interface {\n}\n"), /framework.go has no Frontend interface/);
  assert.throws(() => rustPortMethods("pub trait Frontend {\n}\n"), /framework.rs has no Framework trait/);
});

test("a method of one framework port passes only when a row P lists it", { timeout: 1000 }, () => {
  const changed = sources();
  assert.deepEqual(auditHostParity(changed), []);
  changed.wailsv3PortSource = goPortFixture.replace("IsMaximized() bool", "IsMaximised() bool");
  assert.deepEqual(auditHostParity(changed), [
    "the Go Frontend port has IsMaximised, which the Rust Frontend port does not have (is_maximised) and no row P lists",
    "the Rust Frontend port has is_maximized, which the Go Frontend port does not have and no row P lists",
  ]);
});

test("a row P of a method that its language does not have, or that both languages have, fails", { timeout: 1000 }, () => {
  const go = goPortMethods(goPortFixture);
  const rust = rustPortMethods(rustPortFixture);
  const allowed = { go: new Map([["Framework.Windows", "P3"], ["Framework.Quit", "P4"]]), rust: new Map([["Frontend.scale_factor", "P2"], ["Frontend.focus", "P5"]]) };
  go.get("Framework").splice(1, 1);
  assert.deepEqual(auditPortMethods(go, rust, allowed), [
    "row P3 lists Framework.Windows, which both framework ports have",
    "row P4 lists Framework.Quit, which the Go framework port does not have",
    "row P5 lists Frontend.focus, which the Rust framework port does not have",
  ]);
});

test("a row P reads the port methods of each cell and refuses a cell without one", { timeout: 1000 }, () => {
  const allowed = allowedPortMethods(hostsFixture);
  assert.deepEqual([...allowed.go], [["Framework.Step", "P1"]]);
  assert.deepEqual([...allowed.rust], [["Frontend.scale_factor", "P2"]]);
  assert.throws(() => allowedPortMethods(hostsFixture.replace("\`Framework.Step\`", "Step")), /row P1 has no port method or none in the go cell/);
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

test("a common-only key that the workbench refuses and a host accepts fails", { timeout: 1000 }, () => {
  const changed = { ...sources(), workbenchDeclarationSource: '{"settings": {"commonOnly": ["projectOpening", "textSize", "memorySaver"]}}' };
  assert.deepEqual(auditHostParity(changed), [
    'tauriv2 common-only keys ["projectOpening","textSize"] differ from the common-only keys of the workbench ["memorySaver","projectOpening","textSize"]',
    'wailsv3 common-only keys ["projectOpening","textSize"] differ from the common-only keys of the workbench ["memorySaver","projectOpening","textSize"]',
  ]);
});

test("the common-only keys of the hosts and the workbench are read from their sources", { timeout: 1000 }, async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const keys = commonOnlyKeys({
    tauriv2DeclarationSource: read("packages/host/rust/src/workbench.json"),
    wailsv3DeclarationSource: read("packages/host/go/src/workbench.json"),
    workbenchDeclarationSource: read("packages/workbench/workbench.json"),
  });
  assert.deepEqual(keys.workbench, ["projectOpening", "textSize", "memorySaver", "memorySaverDelay"]);
  assert.deepEqual(auditCommonOnlyKeys(keys), []);
});

test("every platform method with a caller passes", { timeout: 1000 }, () => {
  assert.deepEqual(rustPlatformMethods(rustPlatformFixture), ["set_core_root", "create_surface", "place_webview"]);
  assert.deepEqual(goPlatformMethods(goPlatformFixture), ["SetCoreRoot", "CreateSurface", "AnswerQuitRequests"]);
  assert.deepEqual(platformFailures(platformSources()), []);
});

test("a platform method without a caller outside the platform fails", { timeout: 1000 }, () => {
  const changed = platformSources();
  changed.tauriv2["surfaces.rs"] = changed.tauriv2["surfaces.rs"].replace("    p.place_webview(&view, frame)?;\n", "");
  changed.wailsv3["host.go"] = changed.wailsv3["host.go"].replace("\tapplication.InvokeSync(system.AnswerQuitRequests)\n", "");
  assert.deepEqual(platformFailures(changed), [
    "tauriv2 platform method place_webview has no caller outside src/platform",
    "wailsv3 platform method AnswerQuitRequests has no caller outside src/platform",
  ]);
});

test("a platform method that only a Go framework adapter calls has a caller", { timeout: 1000 }, () => {
  const changed = platformSources();
  changed.wailsv3["host.go"] = changed.wailsv3["host.go"].replace("\tapplication.InvokeSync(system.AnswerQuitRequests)\n", "");
  const applications = applicationSources();
  applications.wailsv3["packages/host/mygo/src/framework.go"] = "package host\n\nfunc (f *Framework) Quit() {\n\tsystem.AnswerQuitRequests()\n}";
  applications.wailsv3["apps/wailsv3/src/main.go"] = "package main\n\nfunc main() {\n\thost.Run()\n\tframework.Quit()\n}";
  assert.deepEqual(platformFailures(changed, applications), []);
});

test("a platform method named only in a comment has no caller", { timeout: 1000 }, () => {
  const changed = platformSources();
  changed.tauriv2["surfaces.rs"] = changed.tauriv2["surfaces.rs"].replace("    p.place_webview(&view, frame)?;", "    // p.place_webview(&view, frame)?;");
  changed.wailsv3["host.go"] = changed.wailsv3["host.go"].replace("\tsurface, err := system.CreateSurface(window)", "\t// system.CreateSurface(window)");
  assert.deepEqual(platformFailures(changed), [
    "tauriv2 platform method place_webview has no caller outside src/platform",
    "wailsv3 platform method CreateSurface has no caller outside src/platform",
  ]);
});

test("auditHostParity reports a platform method of either host that no source outside the platform calls", { timeout: 1000 }, () => {
  const changed = sources();
  changed.tauriv2ProductSources = { "surfaces.rs": changed.tauriv2ProductSources["surfaces.rs"].replace("    let surface = p.create_surface(main)?;\n", "    let surface = 0;\n") };
  changed.wailsv3ProductSources = { "host.go": changed.wailsv3ProductSources["host.go"].replace("\tsystem.SetCoreRoot(resolve)\n", "") };
  assert.deepEqual(auditHostParity(changed), [
    "tauriv2 platform method create_surface has no caller outside src/platform",
    "wailsv3 platform method SetCoreRoot has no caller outside src/platform",
  ]);
});

test("a platform method that only a test item of a Rust source calls has no caller", { timeout: 1000 }, () => {
  const changed = sources();
  const surfaces = changed.tauriv2ProductSources["surfaces.rs"];
  changed.tauriv2ProductSources = {
    "surfaces.rs": surfaces.replace("    p.place_webview(&view, frame)?;\n", "")
      + "\n#[cfg(test)]\n#[path = \"surfaces_test.rs\"]\nmod surfaces_test;\n"
      + "\n#[cfg(test)]\nmod tests {\n    fn probe(p: &dyn Platform) {\n        p.place_webview(&view, frame).unwrap();\n    }\n}\n"
      + "\nfn after() {}\n",
    "diagnostics.rs": "#[cfg(all(test, feature = \"diagnostics\"))]\npub(crate) fn probe(p: &dyn Platform) {\n    p.place_webview(&view, frame).unwrap();\n}\n",
  };
  assert.deepEqual(auditHostParity(changed), ["tauriv2 platform method place_webview has no caller outside src/platform"]);
  assert.equal(withoutRustTestItems(changed.tauriv2ProductSources["surfaces.rs"]),
    surfaces.replace("    p.place_webview(&view, frame)?;\n", "") + "\n\n\nfn after() {}\n");
});

test("a test item without its closing line is an error", { timeout: 1000 }, () => {
  assert.throws(() => withoutRustTestItems("#[cfg(test)]\nmod tests {\n    fn probe() {}\n"),
    /the #\[cfg\(test\)\] item at line 1 has no closing line at its indentation/);
});

test("the product sources of a host are its source files outside the platform folder, without test files", { timeout: 1000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "host-parity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, text] of [["surfaces.rs", "a"], ["routine/routine.rs", "b"], ["platform/darwin/darwin.rs", "c"],
    ["surfaces_test.rs", "d"], ["bridge.js", "e"], ["routine/routine_test.rs", "f"]]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  assert.deepEqual(hostProductSources(directory, ".rs"), { "routine/routine.rs": "b", "surfaces.rs": "a" });
});

test("a platform method whose only callers are free functions that no live function calls has no caller", { timeout: 1000 }, () => {
  const changed = platformSources();
  changed.tauriv2["surfaces.rs"] = changed.tauriv2["surfaces.rs"].replace("    p.place_webview(&view, frame)?;\n", "");
  changed.tauriv2["layout.rs"] = "pub fn place_all(p: &dyn Platform) {\n    p.place_webview(&view, frame)?;\n}\n\npub fn place_twice(p: &dyn Platform) {\n    place_all(p);\n    place_all(p);\n}\n";
  changed.wailsv3["host.go"] = changed.wailsv3["host.go"].replace("\tsurface, err := system.CreateSurface(window)\n", "");
  changed.wailsv3["surfaces.go"] = "package host\n\nfunc createAll() {\n\tsurface, err := system.CreateSurface(window)\n}\n";
  assert.deepEqual(platformFailures(changed), [
    "tauriv2 platform method place_webview has no caller outside src/platform",
    "wailsv3 platform method CreateSurface has no caller outside src/platform",
  ]);
});

test("a free function that a live function, an application or a command calls keeps its platform method called", { timeout: 1000 }, () => {
  const changed = platformSources();
  changed.tauriv2["surfaces.rs"] = changed.tauriv2["surfaces.rs"]
    .replace("    p.place_webview(&view, frame)?;\n", "    crate::layout::place_twice(p);\n")
    .replace("    let surface = p.create_surface(main)?;\n", "");
  changed.tauriv2["layout.rs"] = "pub fn place_all(p: &dyn Platform) {\n    p.place_webview(&view, frame)?;\n}\n\npub fn place_twice(p: &dyn Platform) {\n    place_all(p);\n    place_all(p);\n}\n";
  changed.tauriv2["bindings.rs"] = "bindings! {\n#[tauri::command]\nfn window_new(p: &dyn Platform) {\n    let surface = p.create_surface(main)?;\n}\n}\n";
  changed.wailsv3["host.go"] = changed.wailsv3["host.go"]
    .replace("\tsurface, err := system.CreateSurface(window)\n", "\tcreateAll()\n")
    .replace("\tapplication.InvokeSync(system.AnswerQuitRequests)\n", "");
  changed.wailsv3["surfaces.go"] = "package host\n\nfunc createAll() {\n\tsurface, err := system.CreateSurface(window)\n}\n\nfunc (h *Host) Quit() {\n\tapplication.InvokeSync(system.AnswerQuitRequests)\n}\n";
  assert.deepEqual(platformFailures(changed), []);
});

test("free functions that only call each other have no caller", { timeout: 1000 }, () => {
  const changed = platformSources();
  changed.tauriv2["surfaces.rs"] = changed.tauriv2["surfaces.rs"].replace("    p.place_webview(&view, frame)?;\n", "");
  changed.tauriv2["layout.rs"] = "fn ping(p: &dyn Platform) {\n    pong(p);\n    p.place_webview(&view, frame)?;\n}\n\nfn pong(p: &dyn Platform) {\n    ping(p);\n}\n";
  changed.wailsv3["host.go"] = changed.wailsv3["host.go"].replace("\tsurface, err := system.CreateSurface(window)\n", "");
  changed.wailsv3["surfaces.go"] = "package host\n\nfunc ping() {\n\tpong()\n\tsurface, err := system.CreateSurface(window)\n}\n\nfunc pong() {\n\tping()\n}\n";
  assert.deepEqual(platformFailures(changed), [
    "tauriv2 platform method place_webview has no caller outside src/platform",
    "wailsv3 platform method CreateSurface has no caller outside src/platform",
  ]);
});

test("the library crate of a host is the package name in Rust form and its root file under src", { timeout: 1000 }, () => {
  const manifest = '[package]\nname = "soksak-host-tauriv2"\nedition = "2024"\n\n[lib]\npath = "src/host.rs"\n';
  assert.deepEqual(libraryCrate(manifest, "Cargo.toml"), { root: "host.rs", name: "soksak_host_tauriv2" });
  assert.throws(() => libraryCrate('[package]\nname = "soksak-host-tauriv2"\n', "Cargo.toml"),
    /Cargo.toml declares no package name or no \[lib\] path under src\//);
  assert.throws(() => libraryCrate('[lib]\npath = "src/host.rs"\n', "Cargo.toml"),
    /Cargo.toml declares no package name or no \[lib\] path under src\//);
});
