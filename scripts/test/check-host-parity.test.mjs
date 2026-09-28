import assert from "node:assert/strict";
import test from "node:test";
import { auditHostParity, snake } from "../check-host-parity.mjs";

// 주입 검사의 기준 소스. 실제 소스에서 이름 하나만 바꿔 각 실패가 기계적으로 나오는지 증명한다.
const sources = () => ({
  tauriv2Runtime: 'const COMMAND = {\n  windowNew: "window_new",\n  overlayShow: "overlay_show",\n};',
  tauriv2Bindings: 'generate_handler![\n  window_new,\n  overlay_show,\n]',
  wailsv3Runtime: 'const METHOD = {\n  windowNew: "WindowNew",\n  overlayShow: "OverlayShow",\n}',
  wailsv3HostSources: { "host.go": "func (h *Host) WindowNew(ctx context.Context) error { return nil }\nfunc (h *Host) OverlayShow(ctx context.Context) error { return nil }" },
  tauriv2EndpointSource: 'const METHODS: &[&str] = &[\n  "windows.list",\n];\nconst DIAGNOSTICS: &[&str] = &[\n  "diagnostics.fixture",\n];',
  wailsv3EndpointSource: 'var endpointMethods = map[string]endpointMethod{\n  "windows.list": nil,\n}\nvar subscriptionMethods = map[string]subscriptionMethod{}\nvar diagnosticSubscriptions = map[string]subscriptionMethod{}',
  wailsv3DiagnosticsSource: 'func init() {\n  diagnosticMethods["diagnostics.fixture"] = nil\n}',
});

test("equal surfaces pass with no failure", () => {
  assert.deepEqual(auditHostParity(sources()), []);
});

test("a call name that exists on one host only fails", () => {
  const changed = sources();
  changed.tauriv2Runtime = changed.tauriv2Runtime.replace('windowNew: "window_new",', 'windowNew: "window_new",\n  linkOpen: "link_open",');
  changed.tauriv2Bindings = changed.tauriv2Bindings.replace('window_new,', 'window_new,\n  link_open,');
  assert.deepEqual(auditHostParity(changed), ["tauriv2 host.call(link_open) does not exist on wailsv3"]);
});

test("a call name without its host implementation fails", () => {
  for (const [label, changed] of [
    ["tauriv2", () => { const next = sources(); next.tauriv2Bindings = next.tauriv2Bindings.replace("  overlay_show,", ""); return next; }],
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
