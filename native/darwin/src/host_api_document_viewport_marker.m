// Native implementation of the host binding helpers formerly owned by document_viewport_marker.go.
#include "host_api_document_viewport_marker.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "document_view.h"
#include "main_thread.h"

// The native call runs on the main thread (main_thread.h).
bool main_sp_document_viewport_marker(void *document, bool enabled, uint8_t *rgb3, double *borderWidth, char **error) {
    return ON_MAIN(bool, sp_document_viewport_marker(document, enabled, rgb3, borderWidth, error));
}
