#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.

void inputSourceSelectAndAwait(const char *identifier, uintptr_t callback);
// The role table of input_source.h: the identifier of a role and the role of an identifier, static strings or NULL.
const char *inputSourceRoleIdentifier(const char *role);
const char *inputSourceIdentifierRole(const char *identifier);
char *main_sp_input_source_current(void);
