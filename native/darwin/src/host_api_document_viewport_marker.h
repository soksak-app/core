#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.

#ifdef SOKSAK_DIAGNOSTIC
bool main_sp_document_viewport_marker(void *document, bool enabled, uint8_t *rgb3, double *borderWidth, char **error);
#endif
