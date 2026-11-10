#include "host_api_window_objects.h"

#include <stdbool.h>
#include <stdint.h>
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native call runs on the main thread (main_thread.h).
static void counted(void *context, const sp_window_objects *counts, bool reached) {
    long compositions = counts->windowCompositions, hosts = counts->surfaceHosts, registrations = counts->inputRegistrations;
    hostRunOnWorker(^{ sp_host_diagnostic_callback_window_objects_counted((uintptr_t)context, compositions, hosts, registrations, reached); });
}
void countWhen(const sp_window_objects *expected, uintptr_t handle) {
    // The expected count is copied: the block runs after the caller returned.
    bool has = expected != NULL;
    sp_window_objects wanted = has ? *expected : (sp_window_objects){0};
    hostRunOnMain(^{ sp_window_objects_when(has ? &wanted : NULL, counted, (void *)handle); });
}
void endCountWait(uintptr_t handle) {
    hostRunOnMain(^{ sp_window_objects_end((void *)handle); });
}
