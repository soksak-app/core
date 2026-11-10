#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
void whenExited(int32_t pid, uintptr_t handle);
// Ends the wait of handle that has not answered; its callback answers that the process did not exit.
void endExitWait(uintptr_t handle);
