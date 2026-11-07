#include "host_api_mouse_buttons.h"

#include <stdbool.h>
#include "mouse_buttons.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native call runs on the main thread (main_thread.h).
static void mouseButtonsChangedBridge(void *context, unsigned long long mask) {
    hostRunOnWorker(^{ sp_host_callback_mouse_buttons_changed((uintptr_t)context, mask); });
}
bool watchButtons(void) {
    return ON_MAIN(bool, sp_mouse_buttons_watch(mouseButtonsChangedBridge, NULL));
}
