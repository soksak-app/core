#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
bool startMemoryPressure(void);
bool main_sp_memory_pressure_inject(const char *level);
