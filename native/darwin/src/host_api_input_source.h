#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.

#ifdef SOKSAK_DIAGNOSTIC
void inputSourceSelectAndAwait(const char *identifier, uintptr_t callback);
char *main_sp_input_source_current(void);
#endif
