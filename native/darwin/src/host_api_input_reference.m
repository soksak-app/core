// Native implementation of the host binding helpers formerly owned by input_reference.go.
#include "host_api_input_reference.h"

#include <stdint.h>
#include <stdlib.h>
#include "input_reference.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native call runs on the main thread (main_thread.h).
static void referenceReply(void *context, const char *reply, const char *failure) {
    hostRunOnWorker(^{ sp_host_diagnostic_callback_input_reference_reply((uintptr_t)context, (char *)reply, (char *)failure); });
}
void inputReference(uintptr_t window, const char *action, const char *document, uintptr_t context) {
    hostRunOnMain(^{ sp_input_reference((void *)window, action, document, referenceReply, (void *)context); });
}
