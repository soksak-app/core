#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.

bool main_sp_input_person(uintptr_t window, const char *action, double x, double y, char **error);
