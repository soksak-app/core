#include "host_api_page_objects.h"

#include <stdbool.h>
#include <stdint.h>
#include "webview_geometry.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native call runs on the main thread (main_thread.h).
static void pageCounted(void *context, long elements, long documents, const char *failure) {
    hostRunOnWorker(^{ sp_host_diagnostic_callback_page_objects_counted((uintptr_t)context, elements, documents, (char *)failure); });
}
void countPageObjects(void *view, bool document, uintptr_t handle) {
    hostRunOnMain(^{ sp_webview_count_objects(view, document, pageCounted, (void *)handle); });
}
