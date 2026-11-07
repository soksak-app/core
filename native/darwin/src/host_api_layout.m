#include "host_api_layout.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "surface_layout.h"
#include "main_thread.h"
#include "host_callbacks.h"

void main_sp_host_presentation_complete(void *completion, const char *failure) {
    hostRunOnMain(^{ sp_host_presentation_complete(completion, failure); });
}

// The native calls of this file run on the main thread (main_thread.h).
bool main_surfaceLayoutCommit(uintptr_t window, uint64_t ticket) { return ON_MAIN(bool, surfaceLayoutCommit((void *)window, ticket)); }
void main_surfaceLayoutCancel(uintptr_t window) { hostRunOnMain(^{ surfaceLayoutCancel((void *)window); }); }
void main_surfaceLayoutCancelTicket(uintptr_t window, uint64_t ticket) {
    hostRunOnMain(^{ surfaceLayoutCancelTicket((void *)window, ticket); });
}
bool main_surfaceLayoutAbandonView(uintptr_t window, void *view) {
    return ON_MAIN(bool, surfaceLayoutAbandonView((void *)window, view));
}
void main_surfaceLayoutInjectSettledFailure(void) { hostRunOnMain(^{ surfaceLayoutInjectSettledFailure(); }); }
