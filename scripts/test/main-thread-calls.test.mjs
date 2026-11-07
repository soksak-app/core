import assert from "node:assert/strict";
import test from "node:test";
import { auditMainThreadCalls } from "../check-host-files.mjs";

// The fixtures use the paths of the darwin layer of the Wails host and of the headers of native/darwin, which the audit selects.
const LAYER = "packages/host/go/src/platform/darwin";
const HEADER = "native/darwin/src/window_facts.h";
const header = [
  "#import <Cocoa/Cocoa.h>",
  "#include <stdbool.h>",
  "void *sp_app_main_window(void);",
  "bool sp_window_close(void *window);",
  "unsigned long long sp_mono_ns(void);",
  "typedef void (*sp_ui_task)(unsigned long);",
  "void sp_ui_enqueue(sp_ui_task task, unsigned long context);",
  "@interface SPWindowFacts : NSObject",
  "- (void)close:(id)sender;",
  "@end",
].join("\n");
// The worker functions of the framework and their macros, as main_thread.h of the darwin layer declares them.
const mainThread = [
  "void hostRunOnWorker(void (^task)(void));",
  "void hostRunOnMain(void (^call)(void));",
  "#define ON_MAIN(T, expression) ({ __block T onMainResult; hostRunOnMain(^{ onMainResult = (expression); }); onMainResult; })",
  "#define ON_WORKER(T, expression) ({ __block T onWorkerResult; hostRunOnWorker(^{ onWorkerResult = (expression); }); onWorkerResult; })",
].join("\n");
const base = { [HEADER]: header, ["native/darwin/src/main_thread.h"]: mainThread };

test("main-thread audit accepts native dispatch installation and queries without dispatching them", { timeout: 30000 }, () => {
  const files = {
    ...base,
    "native/darwin/src/main_thread.h": mainThread + "\n#include <stdbool.h>\nvoid hostInstallMainThread(void (*worker)(void (^)(void)), void (*main)(void (^)(void)));\nvoid hostMainThreadInstalled(bool *worker, bool *main);",
    [`${LAYER}/ui_queue.go`]: goFile([
      '#include "main_thread.h"',
      'static void install(void) { hostInstallMainThread(0, 0); }',
      'static void installed(void) { bool worker, main; hostMainThreadInstalled(&worker, &main); }',
    ].join("\n"), 'func configure() { C.install(); C.installed() }'),
  };
  assert.deepEqual(auditMainThreadCalls(files), []);
});

test("main-thread audit accepts native startup signal masking without dispatch", { timeout: 30000 }, () => {
  const files = {
    ...base,
    "native/darwin/src/signals.h": "int sp_block_async_signals(void);",
    [`${LAYER}/termination.go`]: goFile('#include "signals.h"', "func prepare() { C.sp_block_async_signals() }"),
  };
  assert.deepEqual(auditMainThreadCalls(files), []);
});

/** Returns a Go file of the darwin layer with the preamble and the Go body. */
function goFile(preamble, body) {
  return `//go:build darwin\n\npackage darwin\n\n/*\n${preamble}\n*/\nimport "C"\n\n${body}\n`;
}

const exported = "//export goWindowClosed\nfunc goWindowClosed() {}\n";

test("main-thread audit protects registered native callback entries with the same worker boundary", { timeout: 30000 }, () => {
  const files = {
    ...base,
    "native/darwin/src/host_callbacks.h": "void sp_host_callback_ready(unsigned long context);",
    [`${LAYER}/callbacks.go`]: goFile([
      '#include "main_thread.h"',
      '#include "host_callbacks.h"',
      'static void valid(void) { hostRunOnWorker(^{ sp_host_callback_ready(17); }); }',
      'static void invalid(void) { sp_host_callback_ready(17); }',
    ].join("\n"), "func drive() { C.valid(); C.invalid(); C.sp_host_callback_ready(17) }"),
  };
  const errors = auditMainThreadCalls(files);
  assert.equal(errors.length, 2, errors.join("\n"));
  assert.match(errors[0], /sp_host_callback_ready.*outside hostRunOnWorker or ON_WORKER/);
  assert.match(errors[1], /Go calls callback sp_host_callback_ready directly/);
});

test("main-thread audit accepts exported callbacks that run through the worker", { timeout: 30000 }, () => {
  const files = {
    ...base,
    [`${LAYER}/window.go`]: goFile([
      "#include \"main_thread.h\"",
      "extern void goWindowClosed(void);",
      "extern int goWindowHit(void);",
      "static void windowClosed(void) { hostRunOnWorker(^{ goWindowClosed(); }); }",
      "static int windowHit(void) { return ON_WORKER(int, goWindowHit()); }",
    ].join("\n"), `${exported}//export goWindowHit\nfunc goWindowHit() C.int { return 0 }\n`),
  };
  assert.deepEqual(auditMainThreadCalls(files), []);
});

test("main-thread audit rejects an exported callback that C calls directly", { timeout: 30000 }, () => {
  const files = {
    ...base,
    [`${LAYER}/window.go`]: goFile([
      "extern void goWindowClosed(void);",
      "static void windowClosed(void) { goWindowClosed(); }",
    ].join("\n"), exported),
  };
  assert.deepEqual(auditMainThreadCalls(files), [
    `${LAYER}/window.go:7: goWindowClosed is exported to C and is referenced outside hostRunOnWorker or ON_WORKER`,
  ]);
});

test("main-thread audit rejects an exported callback that an Objective-C file passes to native code", { timeout: 30000 }, () => {
  const files = {
    ...base,
    [`${LAYER}/window.go`]: goFile("", exported),
    [`${LAYER}/webview.m`]: [
      "#import \"window_facts.h\"",
      "extern void goWindowClosed(void);",
      "@interface SPDelegate : NSObject",
      "@end",
      "@implementation SPDelegate",
      "- (void)windowWillClose:(NSNotification *)notification {",
      "    sp_ui_enqueue((sp_ui_task)goWindowClosed, 0);",
      "}",
      "@end",
    ].join("\n"),
  };
  assert.deepEqual(auditMainThreadCalls(files), [
    `${LAYER}/webview.m:7: goWindowClosed is exported to C and is referenced outside hostRunOnWorker or ON_WORKER`,
  ]);
});

test("main-thread audit rejects a native call that Go makes directly instead of through a main_ wrapper", { timeout: 30000 }, () => {
  const files = {
    ...base,
    [`${LAYER}/window.go`]: goFile([
      "#include \"window_facts.h\"",
      "#include \"main_thread.h\"",
      "static void *main_sp_app_main_window(void) { return ON_MAIN(void *, sp_app_main_window()); }",
    ].join("\n"), [
      "func wrapped() unsafe.Pointer { return C.main_sp_app_main_window() }",
      "func clock() uint64 { return uint64(C.sp_mono_ns()) }",
      "func direct(window unsafe.Pointer) bool { return bool(C.sp_window_close(window)) }",
      "// C.sp_window_close(window) in a comment is not a call.",
      "const text = \"C.sp_window_close(window)\"",
    ].join("\n")),
  };
  assert.deepEqual(auditMainThreadCalls(files), [
    `${LAYER}/window.go:14: Go calls the native function sp_window_close directly; call a main_ wrapper that runs it through hostRunOnMain or ON_MAIN`,
  ]);
});

test("main-thread audit rejects a preamble function that Go calls and that uses AppKit outside the main thread", { timeout: 30000 }, () => {
  const files = {
    ...base,
    [`${LAYER}/window.go`]: goFile([
      "#include \"window_facts.h\"",
      "#include \"main_thread.h\"",
      "static bool closeOnMain(void *window) { return sp_window_close(window); }",
      "static bool closeWindow(void *window) { return closeOnMain(window); }",
      "static void orderOut(void *window) { [(NSWindow *)window orderOut:nil]; }",
      "static void miniaturize(void *window) { NSWindow *view = (NSWindow *)[(id)window self]; (void)view; }",
      "static bool closeWrapped(void *window) { return ON_MAIN(bool, closeOnMain(window)); }",
      "static int sum(int *values) { return values[0] + values[1]; }",
      "static void onWorker(void *window) { hostRunOnWorker(^{ sp_window_close(window); }); }",
    ].join("\n"), [
      "func calls(window unsafe.Pointer, values *C.int) {",
      "\tC.closeWindow(window)",
      "\tC.orderOut(window)",
      "\tC.miniaturize(window)",
      "\tC.closeWrapped(window)",
      "\tC.sum(values)",
      "}",
    ].join("\n")),
  };
  assert.deepEqual(auditMainThreadCalls(files), [
    `${LAYER}/window.go:14: sp_window_close runs on the worker inside hostRunOnWorker or ON_WORKER; run it through hostRunOnMain or ON_MAIN`,
    `${LAYER}/window.go:19: Go calls closeWindow, which calls closeOnMain (line 9), which calls the native function sp_window_close (line 8) outside hostRunOnMain or ON_MAIN`,
    `${LAYER}/window.go:20: Go calls orderOut, which sends an Objective-C message (line 10) outside hostRunOnMain or ON_MAIN`,
    `${LAYER}/window.go:21: Go calls miniaturize, which sends an Objective-C message (line 11) outside hostRunOnMain or ON_MAIN`,
  ]);
});

test("main-thread audit counts a call of a block as a call of a native function", { timeout: 30000 }, () => {
  const files = {
    ...base,
    // A main-thread function that runs its block directly before an installation does not count for its callers.
    [`${LAYER}/main_thread.m`]: [
      "#include \"main_thread.h\"",
      "void hostRunOnWorker(void (^task)(void)) { task(); }",
      "void hostRunOnMain(void (^call)(void)) { call(); }",
    ].join("\n"),
    [`${LAYER}/layout.go`]: goFile([
      "#include \"window_facts.h\"",
      "#include \"main_thread.h\"",
      "typedef void (^finished)(const char *error);",
      "static void finishOutside(void *block) { ((finished)block)(NULL); }",
      "static void finishNamed(finished block) { block(NULL); }",
      "static void finishPlain(void (^block)(void)) { block(); }",
      "static void finishOnMain(finished block) { hostRunOnMain(^{ block(NULL); }); }",
      "static void finishOnWorker(finished block) { hostRunOnWorker(^{ block(NULL); }); }",
      "static void finishPointer(void (*function)(void)) { function(); }",
    ].join("\n"), [
      "func calls(block unsafe.Pointer, function *[0]byte) {",
      "\tC.finishOutside(block)",
      "\tC.finishNamed(C.finished(block))",
      "\tC.finishPlain(block)",
      "\tC.finishOnMain(C.finished(block))",
      "\tC.finishPointer(function)",
      "}",
    ].join("\n")),
  };
  assert.deepEqual(auditMainThreadCalls(files), [
    `${LAYER}/layout.go:13: a block is called on the worker inside hostRunOnWorker or ON_WORKER; run it through hostRunOnMain or ON_MAIN`,
    `${LAYER}/layout.go:19: Go calls finishOutside, which calls a block (line 9) outside hostRunOnMain or ON_MAIN`,
    `${LAYER}/layout.go:20: Go calls finishNamed, which calls a block (line 10) outside hostRunOnMain or ON_MAIN`,
    `${LAYER}/layout.go:21: Go calls finishPlain, which calls a block (line 11) outside hostRunOnMain or ON_MAIN`,
  ]);
});

test("main-thread audit names the thread-safe native functions with a reason", { timeout: 30000 }, async () => {
  const { MAIN_THREAD_FREE } = await import("../check-host-files.mjs");
  for (const [name, reason] of Object.entries(MAIN_THREAD_FREE)) {
    assert.match(name, /^(?:sp_[a-z_*]+|hostInstallMainThread|hostMainThreadInstalled)$/, name);
    assert.ok(reason.length > 20, `${name} has no reason`);
  }
});

test("main-thread audit reads the darwin layer of the Go language host library through hostRunOnWorker and hostRunOnMain", { timeout: 30000 }, () => {
  const layer = "packages/host/go/src/platform/darwin";
  const worker = [
    "void hostRunOnWorker(void (^task)(void));",
    "void hostRunOnMain(void (^call)(void));",
    "#define ON_MAIN(T, expression) ({ __block T onMainResult; hostRunOnMain(^{ onMainResult = (expression); }); onMainResult; })",
    "#define ON_WORKER(T, expression) ({ __block T onWorkerResult; hostRunOnWorker(^{ onWorkerResult = (expression); }); onWorkerResult; })",
  ].join("\n");
  const files = {
    [HEADER]: header,
    [`${layer}/main_thread.h`]: worker,
    [`${layer}/window.go`]: goFile([
      "#include \"main_thread.h\"",
      "extern void goWindowClosed(void);",
      "static void windowClosed(void) { hostRunOnWorker(^{ goWindowClosed(); }); }",
      "static void windowClosedAtOnce(void) { goWindowClosed(); }",
    ].join("\n"), exported),
  };
  assert.deepEqual(auditMainThreadCalls(files), [
    `${layer}/window.go:9: goWindowClosed is exported to C and is referenced outside hostRunOnWorker or ON_WORKER`,
  ]);
});

const GENERATED_BINDING = "packages/host/wailsv3/src/platform/darwin/bindings/native_api.go";
const CANONICAL_WRAPPER = "native/darwin/src/host_api_fixture.m";
function migratedFiles(implementation, body = "func use() { C.main_fixture() }") {
  return {
    ...base,
    "native/darwin/src/host_api_fixture.h": "void main_fixture(void);",
    [GENERATED_BINDING]: goFile('#include "host_api_fixture.h"', body),
    [CANONICAL_WRAPPER]: '#include "main_thread.h"\n#include "window_facts.h"\n#include "host_api_fixture.h"\n' + implementation,
  };
}

test("main-thread audit rejects unguarded AppKit in a canonical wrapper reached through generated Wails bindings", { timeout: 30000 }, () => {
  const errors = auditMainThreadCalls(migratedFiles('void main_fixture(void) { [NSApp terminate:nil]; }'));
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /packages\/host\/wailsv3.*Go calls main_fixture.*Objective-C message.*outside hostRunOnMain or ON_MAIN/);
});

test("main-thread audit follows guarded canonical wrapper definitions across the generated binding boundary", { timeout: 30000 }, () => {
  assert.deepEqual(auditMainThreadCalls(migratedFiles('static void perform(void) { [NSApp terminate:nil]; }\nvoid main_fixture(void) { hostRunOnMain(^{ perform(); }); }')), []);
});

test("main-thread audit rejects direct native calls from generated Wails bindings", { timeout: 30000 }, () => {
  const files = migratedFiles('void main_fixture(void) {}', 'func use() { C.sp_window_close(nil) }');
  files[GENERATED_BINDING] = goFile('#include "window_facts.h"', 'func use() { C.sp_window_close(nil) }');
  const errors = auditMainThreadCalls(files);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /Go calls the native function sp_window_close directly/);
});

test("main-thread audit enforces registered callback worker boundaries in canonical native wrapper sources", { timeout: 30000 }, () => {
  const files = migratedFiles('void main_fixture(void) { sp_host_callback_ready(17); }');
  files["native/darwin/src/host_callbacks.h"] = "void sp_host_callback_ready(unsigned long context);";
  files[CANONICAL_WRAPPER] = '#include "host_callbacks.h"\n' + files[CANONICAL_WRAPPER];
  let errors = auditMainThreadCalls(files);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /host_api_fixture.m.*sp_host_callback_ready.*outside hostRunOnWorker or ON_WORKER/);
  files[CANONICAL_WRAPPER] = files[CANONICAL_WRAPPER].replace('sp_host_callback_ready(17);', 'hostRunOnWorker(^{ sp_host_callback_ready(17); });');
  assert.deepEqual(auditMainThreadCalls(files), []);
});

test("main-thread audit copies canonical private headers without replacing their declarations", { timeout: 30000 }, () => {
  const files = migratedFiles('void main_fixture(void) { hostRunOnMain(^{ privateClose(); }); }');
  files["native/darwin/src/private/fixture.h"] = "void privateClose(void);";
  files[CANONICAL_WRAPPER] = '#include "private/fixture.h"\n' + files[CANONICAL_WRAPPER];
  assert.deepEqual(auditMainThreadCalls(files), []);
});
