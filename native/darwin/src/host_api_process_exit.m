#include "host_api_process_exit.h"

#include <stdbool.h>
#include <stdint.h>
#include "process_exit.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native call runs on the main thread (main_thread.h).
static void answered(void *context, bool exited) {
    hostRunOnWorker(^{ sp_host_diagnostic_callback_process_exit_answered((uintptr_t)context, exited); });
}
void whenExited(int32_t pid, double seconds, uintptr_t handle) {
    hostRunOnMain(^{ sp_process_when_exited(pid, seconds, answered, (void *)handle); });
}
