#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.

#ifdef SOKSAK_DIAGNOSTIC
bool main_sp_document_draw_covered(uintptr_t window, bool draw);
#endif
