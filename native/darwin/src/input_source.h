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

// Calls adopted on the main thread with NULL once the text input context of the key view holds the input source identifier,
// at once when there is no such context or it already holds it, and with the reason after 2 seconds in which the context
// did not report it. The text input context takes a source that the system selected only later, so a key typed before
// adopted runs reaches the earlier source. Call it on the main thread.
void sp_input_source_await(const char *identifier, void (^adopted)(const char *error));
