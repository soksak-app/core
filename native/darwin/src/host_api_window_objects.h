#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "window_objects.h"

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
void countWhen(const sp_window_objects *expected, uintptr_t handle);
// Ends the count wait of handle that has not answered; its callback answers the current count, not reached.
void endCountWait(uintptr_t handle);
