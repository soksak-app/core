// The diagnostic input reference: an ordinary AppKit text view in one application window.
#pragma once

// Reply and failure are borrowed UTF-8 strings, valid only during the callback. Exactly one is non-NULL.
typedef void (*sp_input_reference_done)(void *context, const char *reply, const char *failure);

// Call on the main thread. Actions are open, read, focus, wait and close; only wait accepts expected.
// Wait observes document changes for at most five seconds and requires no marked text.
// Focus selects an open control with makeFirstResponder without activation.
// Open never activates or focuses. Close and window closure remove the reference and cancel a pending wait.
void sp_input_reference(void *window, const char *action, const char *expected, sp_input_reference_done done, void *context);
