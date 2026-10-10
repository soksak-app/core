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
