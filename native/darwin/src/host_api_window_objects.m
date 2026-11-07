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
void countWhen(const sp_window_objects *expected, double seconds, uintptr_t handle) {
    hostRunOnMain(^{ sp_window_objects_when(expected, seconds, counted, (void *)handle); });
}
