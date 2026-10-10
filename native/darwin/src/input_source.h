// Reads and changes the selected keyboard input source.
//
// Used by window checks that reproduce input method behavior to create the same input source order as a user (for
// example a Roman layout followed by Korean 2-set). Call both functions on the main thread.
#pragma once
#include <stdbool.h>

// Returns the identifier of the currently selected keyboard input source as a malloc-allocated string; the caller frees it.
// Returns NULL when the input source cannot be read.
char *sp_input_source_current(void);

// Selects the enabled input source with the same identifier. Returns false when there is none or it cannot be selected.
bool sp_input_source_select(const char *identifier);
