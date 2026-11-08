// Native implementation of the host binding helpers formerly owned by document_draw_covered.go.
#include "host_api_document_draw_covered.h"

#include <stdbool.h>
#include "document_view.h"
#include "main_thread.h"

// The native call runs on the main thread (main_thread.h).
bool main_sp_document_draw_covered(uintptr_t window, bool draw) {
    return ON_MAIN(bool, sp_document_draw_covered((void *)window, draw));
}
