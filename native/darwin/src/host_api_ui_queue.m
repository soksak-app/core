#include "host_api_ui_queue.h"

#include "ui_queue.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The main queue runs the step in C: the work runs on the worker while the main thread waits (main_thread.h).
static void nativeUIRun(uintptr_t context) {
    hostRunOnWorker(^{ sp_host_callback_native_ui_run(context); });
}
void uiEnqueue(uintptr_t context) { sp_ui_enqueue(nativeUIRun, context); }
void installMainThread(uintptr_t worker, uintptr_t main) {
    hostInstallMainThread((void (*)(void (^)(void)))worker, (void (*)(void (^)(void)))main);
}
void mainThreadInstalled(bool *worker, bool *main) { hostMainThreadInstalled(worker, main); }
