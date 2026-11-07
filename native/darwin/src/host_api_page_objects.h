#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
void countPageObjects(void *view, bool document, uintptr_t handle);
