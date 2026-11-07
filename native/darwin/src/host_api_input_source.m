// Native implementation of the host binding helpers formerly owned by input_source.go.
#include "host_api_input_source.h"

#ifdef SOKSAK_DIAGNOSTIC
#include <stdint.h>
#include <stdlib.h>
#include "input_source.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).

void inputSourceSelectAndAwait(const char *identifier, uintptr_t callback) {
    hostRunOnMain(^{
        sp_input_source_select_and_await(identifier, ^(const char *error) {
            hostRunOnWorker(^{ sp_host_diagnostic_callback_native_input_source_adopted(callback, (char *)error); });
        });
    });
}
char *main_sp_input_source_current(void) { return ON_MAIN(char *, sp_input_source_current()); }
#endif
