#include "host_api_memory_pressure.h"

#include <stdbool.h>
#include <stdlib.h>
#include "memory_pressure.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The report runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).
bool startMemoryPressure(void) {
    return ON_MAIN(bool, sp_memory_pressure_start(^(const char *level, unsigned long long seq) {
        hostRunOnWorker(^{ sp_host_callback_memory_pressure((char *)level, seq); });
    }));
}
bool main_sp_memory_pressure_inject(const char *level) { return ON_MAIN(bool, sp_memory_pressure_inject(level)); }
