#ifndef SOKSAK_HOST_MAIN_THREAD_H
#define SOKSAK_HOST_MAIN_THREAD_H

#include <stdbool.h>

// The main-thread functions of the framework (docs/spec/hosts.md, main thread of the Wails host). The framework adapter installs them
// before the start of the library, from the functions of its framework; native/darwin holds what it installed. Go code runs on
// the worker of the framework, never on the main thread:
//
// - Each callback of the native code into Go runs its Go function through hostRunOnWorker, which hands it to the worker while
//   the main thread waits in C and returns when the Go function returned.
// - Each call of Go code into AppKit or WebKit runs its body through hostRunOnMain, which forwards the body from the worker to
//   the waiting main thread and returns when the body returned. On another thread both run the block directly.
//
// Both are required: the start of the library fails when one is not installed (hostMainThreadInstalled), and a call of one that
// is not installed ends the process with its name. A test that runs the darwin layer without a framework adapter installs a test
// function for both in its TestMain.
void hostRunOnWorker(void (^task)(void));
void hostRunOnMain(void (^call)(void));

// hostInstallMainThread installs the functions of the framework.
void hostInstallMainThread(void (*worker)(void (^)(void)), void (*main)(void (^)(void)));

// hostMainThreadInstalled reports for each of the two functions whether it is installed.
void hostMainThreadInstalled(bool *worker, bool *main);

// ON_MAIN evaluates the expression of type T on the main thread through hostRunOnMain and yields its value.
#define ON_MAIN(T, expression) ({ \
    __block T onMainResult; \
    hostRunOnMain(^{ onMainResult = (expression); }); \
    onMainResult; \
})

// ON_WORKER evaluates the expression of type T on the worker through hostRunOnWorker and yields its value.
#define ON_WORKER(T, expression) ({ \
    __block T onWorkerResult; \
    hostRunOnWorker(^{ onWorkerResult = (expression); }); \
    onWorkerResult; \
})

#endif
