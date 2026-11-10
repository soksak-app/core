#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.

void inputReference(uintptr_t window, const char *action, const char *document, uintptr_t context);
// Ends the pending wait of the input reference of window, naming reason in its failure.
void endInputReferenceWait(uintptr_t window, const char *reason);
