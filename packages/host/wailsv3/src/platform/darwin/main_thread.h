#ifndef SOKSAK_WAILS_MAIN_THREAD_H
#define SOKSAK_WAILS_MAIN_THREAD_H

#include <stdbool.h>

// The main-thread worker of the Wails framework (docs/spec/hosts.md, main thread of the Wails host). The application package of
// the framework defines these functions in mainthread_darwin.m and declares them in mainthread_darwin.h; this package imports
// that package, so the functions are linked into every program of this package. Go code runs on the worker, never on the main
// thread:
//
// - Each callback of the native code into Go runs its Go function through wailsRunOnWorker, which hands it to the worker while
//   the main thread waits in C and returns when the Go function returned.
// - Each call of Go code into AppKit or WebKit runs its body through wailsRunOnMain, which forwards the body from the worker to
//   the waiting main thread and returns when the body returned. On another thread both run the block directly.
void wailsRunOnWorker(void (^task)(void));
void wailsRunOnMain(void (^call)(void));

// ON_MAIN evaluates the expression of type T on the main thread through wailsRunOnMain and yields its value.
#define ON_MAIN(T, expression) ({ \
    __block T onMainResult; \
    wailsRunOnMain(^{ onMainResult = (expression); }); \
    onMainResult; \
})

// ON_WORKER evaluates the expression of type T on the worker through wailsRunOnWorker and yields its value.
#define ON_WORKER(T, expression) ({ \
    __block T onWorkerResult; \
    wailsRunOnWorker(^{ onWorkerResult = (expression); }); \
    onWorkerResult; \
})

#endif
