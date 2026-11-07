#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
void uiEnqueue(uintptr_t context);
void uiEnqueueAfter(uint64_t delay, uintptr_t context);
void installMainThread(uintptr_t worker, uintptr_t main);
void mainThreadInstalled(bool *worker, bool *main);
