import assert from "node:assert/strict";
import test from "node:test";
import { auditMainThreadCalls } from "../check-hosts.mjs";

// The fixtures use the paths of the darwin layer of the Wails host and of the headers of native/darwin, which the audit selects.
const LAYER = "packages/host/wailsv3/src/platform/darwin";
const HEADER = "native/darwin/src/window_facts.h";
const header = [
  "#include <stdbool.h>",
  "void *sp_app_main_window(void);",
  "bool sp_window_close(void *window);",
  "unsigned long long sp_mono_ns(void);",
  "typedef void (*sp_ui_task)(unsigned long);",
  "@interface SPWindowFacts : NSObject",
  "- (void)close:(id)sender;",
  "@end",
].join("\n");

/** Returns a Go file of the darwin layer with the preamble and the Go body. */
function goFile(preamble, body) {
  return `//go:build darwin\n\npackage darwin\n\n/*\n${preamble}\n*/\nimport "C"\n\n${body}\n`;
}

const exported = "//export goWindowClosed\nfunc goWindowClosed() {}\n";

test("main-thread audit accepts exported callbacks that run through the worker", { timeout: 1000 }, () => {
  const files = {
    [HEADER]: header,
    [`${LAYER}/window.go`]: goFile([
      "#include \"main_thread.h\"",
      "extern void goWindowClosed(void);",
      "extern int goWindowHit(void);",
      "static void windowClosed(void) { wailsRunOnWorker(^{ goWindowClosed(); }); }",
      "static int windowHit(void) { return ON_WORKER(int, goWindowHit()); }",
    ].join("\n"), `${exported}//export goWindowHit\nfunc goWindowHit() C.int { return 0 }\n`),
  };
  assert.deepEqual(auditMainThreadCalls(files), []);
});

test("main-thread audit rejects an exported callback that C calls directly", { timeout: 1000 }, () => {
  const files = {
    [HEADER]: header,
    [`${LAYER}/window.go`]: goFile([
      "extern void goWindowClosed(void);",
      "static void windowClosed(void) { goWindowClosed(); }",
    ].join("\n"), exported),
  };
  assert.deepEqual(auditMainThreadCalls(files), [
    `${LAYER}/window.go:7: goWindowClosed is exported to C and is referenced outside wailsRunOnWorker or ON_WORKER`,
  ]);
});

test("main-thread audit rejects an exported callback that an Objective-C file passes to native code", { timeout: 1000 }, () => {
  const files = {
    [HEADER]: header,
    [`${LAYER}/window.go`]: goFile("", exported),
    [`${LAYER}/webview.m`]: [
      "extern void goWindowClosed(void);",
      "@implementation SPDelegate",
      "- (void)windowWillClose:(NSNotification *)notification {",
      "    sp_ui_enqueue((sp_ui_task)goWindowClosed, 0);",
      "}",
      "@end",
    ].join("\n"),
  };
  assert.deepEqual(auditMainThreadCalls(files), [
    `${LAYER}/webview.m:4: goWindowClosed is exported to C and is referenced outside wailsRunOnWorker or ON_WORKER`,
  ]);
});

test("main-thread audit rejects a native call that Go makes directly instead of through a main_ wrapper", { timeout: 1000 }, () => {
  const files = {
    [HEADER]: header,
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
    `${LAYER}/window.go:14: Go calls the native function sp_window_close directly; call a main_ wrapper that runs it through wailsRunOnMain or ON_MAIN`,
  ]);
});

test("main-thread audit rejects a preamble function that Go calls and that uses AppKit outside the main thread", { timeout: 1000 }, () => {
  const files = {
    [HEADER]: header,
    [`${LAYER}/window.go`]: goFile([
      "#include \"window_facts.h\"",
      "#include \"main_thread.h\"",
      "static bool closeOnMain(void *window) { return sp_window_close(window); }",
      "static bool closeWindow(void *window) { return closeOnMain(window); }",
      "static void orderOut(void *window) { [(NSWindow *)window orderOut:nil]; }",
      "static void miniaturize(void *window) { NSWindow *view = (NSWindow *)[(id)window self]; (void)view; }",
      "static bool closeWrapped(void *window) { return ON_MAIN(bool, closeOnMain(window)); }",
      "static int sum(int *values) { return values[0] + values[1]; }",
      "static void onWorker(void *window) { wailsRunOnWorker(^{ sp_window_close(window); }); }",
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
    `${LAYER}/window.go:14: sp_window_close runs on the worker inside wailsRunOnWorker or ON_WORKER; run it through wailsRunOnMain or ON_MAIN`,
    `${LAYER}/window.go:19: Go calls closeWindow, which calls closeOnMain (line 9), which calls the native function sp_window_close (line 8) outside wailsRunOnMain or ON_MAIN`,
    `${LAYER}/window.go:20: Go calls orderOut, which sends an Objective-C message (line 10) outside wailsRunOnMain or ON_MAIN`,
    `${LAYER}/window.go:21: Go calls miniaturize, which sends an Objective-C message (line 11) outside wailsRunOnMain or ON_MAIN`,
  ]);
});

test("main-thread audit names the thread-safe native functions with a reason", { timeout: 1000 }, async () => {
  const { MAIN_THREAD_FREE } = await import("../check-hosts.mjs");
  for (const [name, reason] of Object.entries(MAIN_THREAD_FREE)) {
    assert.match(name, /^sp_[a-z_*]+$/, name);
    assert.ok(reason.length > 20, `${name} has no reason`);
  }
});
