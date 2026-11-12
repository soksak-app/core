// The diagnostic input reference: an ordinary AppKit text view in one application window.
#pragma once

#include <stdbool.h>

// Reply and failure are borrowed UTF-8 strings, valid only during the callback. Exactly one is non-NULL.
typedef void (*sp_input_reference_done)(void *context, const char *reply, const char *failure);

// Call on the main thread. Actions are open, read, focus, wait and close; only wait accepts expected.
// Wait observes document changes without a limit and requires no marked text; wait-document does not require it.
// Focus selects an open control with makeFirstResponder without activation. Replies distinguish first-responder focus
// from whether the reference's text input context is current.
// Open never activates or focuses. Close and window closure remove the reference and cancel a pending wait.
void sp_input_reference(void *window, const char *action, const char *expected, sp_input_reference_done done, void *context);

// Whether responder is the open reference of window or a view inside it. The reference is a view of the host outside the
// workbench, so a first responder in it is a native view also in a window whose workbench is native UI. Call on the main thread.
bool sp_input_reference_holds(void *window, void *responder);

// Ends the pending wait of the reference of window, if any: its done gets the failure `input reference did not reach the
// expected document before <reason>: <state>`. Call on the main thread.
void sp_input_reference_end(void *window, const char *reason);
