#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.

bool main_sp_input_check_begin(uintptr_t window);
uint64_t main_sp_input_check_end(uintptr_t window);
