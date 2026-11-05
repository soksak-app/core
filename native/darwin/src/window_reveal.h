#include <stdbool.h>

// First on-screen presentation of a new window.
//
// WebKit draws only the web view of a window that is on screen, and it does not wait for the first draw
// after the window goes on screen (WebViewImpl::windowDidOrderOnScreen is an asynchronous activity state
// change). So a page drawn after the window is shown leaves the window blank while it opens. This function
// prepares the window to go on screen transparent and, when the first document load of the registered main
// web view ends (loading ends, whether it succeeded or failed), makes the window opaque after the next
// presentation ends. The page draws its first screen before its first await, so that presentation is the
// first screen. The caller puts the window on screen after this function.
//
// Call it on the main thread. Returns false when no main web view is registered for the window, and writes
// an error string that the caller releases with free() to error. On success error is NULL.
bool sp_window_reveal_after_load(void *window, char **error);

// Puts a window on screen without taking the front from another application.
//
// The one value is whether the system holds this application as active (NSRunningApplication). Launch Services
// activates an application that a person opens, and an activation brings the windows of the application forward, so
// a window shown before that activation arrives comes forward with it. An active application makes the window key and
// orders it front. An application that is not active orders the window directly above its own frontmost window, or
// behind every window when it shows no other window, and leaves a window that is already its only one where it is. The
// window then is the key window that the application gives the keyboard to when it is activated.
//
// Call it on the main thread (docs/spec/hosts.md#launch-activation).
void sp_window_show(void *window);
