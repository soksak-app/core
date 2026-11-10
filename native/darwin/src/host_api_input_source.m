// Native implementation of the host binding helpers formerly owned by input_source.go.
#include "host_api_input_source.h"

#include <stdint.h>
#include <stdlib.h>
#include "input_source.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).

void inputSourceSelectAndAwait(const char *identifier, uintptr_t callback) {
    hostRunOnMain(^{
        sp_input_source_select_and_await(identifier, (const void *)callback, ^(const char *error) {
            hostRunOnWorker(^{ sp_host_diagnostic_callback_native_input_source_adopted(callback, (char *)error); });
        });
    });
}
void endInputSourceSelection(uintptr_t callback, const char *reason) {
    hostRunOnMain(^{ sp_input_source_selection_end((const void *)callback, reason); });
}
char *main_sp_input_source_current(void) { return ON_MAIN(char *, sp_input_source_current()); }
const char *inputSourceRoleIdentifier(const char *role) { return sp_input_source_role_identifier(role); }
const char *inputSourceIdentifierRole(const char *identifier) { return sp_input_source_identifier_role(identifier); }
