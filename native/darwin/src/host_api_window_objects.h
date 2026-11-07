#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "window_objects.h"

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
void countWhen(const sp_window_objects *expected, double seconds, uintptr_t handle);
