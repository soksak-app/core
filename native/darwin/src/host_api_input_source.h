#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.

void inputSourceSelectAndAwait(const char *identifier, uintptr_t callback);
// Ends the pending selection that inputSourceSelectAndAwait started with callback, naming reason in its failure.
void endInputSourceSelection(uintptr_t callback, const char *reason);
// The role table of input_source.h: the identifier of a role and the role of an identifier, static strings or NULL.
const char *inputSourceRoleIdentifier(const char *role);
const char *inputSourceIdentifierRole(const char *identifier);
char *main_sp_input_source_current(void);
