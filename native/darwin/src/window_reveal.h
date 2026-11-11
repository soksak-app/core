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

// Calls done on the main thread once window is revealed: at once for a window whose reveal is not pending, and otherwise
// right after sp_window_reveal_after_load made it opaque. A window waiting for its reveal shows nothing, so a wait for the
// screen that shows its state waits for the reveal first.
void sp_window_after_reveal(void *window, void (^done)(void));

// Places a new window, before the host shows it, centered in the work area (visibleFrame) of the display of the frontmost window
// of the application, and of the main screen when the application shows no other window. Every framework places a window that it
// creates on NSScreen.mainScreen, the display of the key window of the active application, so the new window of an application
// that is not active would open on the display where another application has its key window. The host moves or sizes the window
// after this call when it restores a stored frame.
//
// Call it on the main thread. Returns false when no display exists, and writes an error string that the caller releases with
// free() to error. On success error is NULL.
bool sp_window_place_new(void *window, char **error);

// Puts a window on screen without taking the front from another application.
//
// The one value is whether the system holds this application as active (NSRunningApplication). Launch Services
// activates an application that a person opens, and an activation brings the windows of the application forward, so
// a window shown before that activation arrives comes forward with it. An active application makes the window key and
// orders it front. An application that is not active orders the window directly above its own frontmost window, or
// behind every window when it shows no other window, and leaves a window that is already its only one where it is. The
// window then is the key window that the application gives the keyboard to when it is activated.
//
// While sp_windows_raise holds the windows of the application raised, the window takes the check window level before it is
// ordered.
//
// Call it on the main thread (docs/spec/hosts.md#launch-activation).
void sp_window_show(void *window);

// Raises the windows of the application above the windows of other applications, or ends that; diagnostic builds call it
// (diagnostics.windows.raise, docs/spec/endpoint.md#diagnostic-builds) so that a check owns the stacking of its windows. With
// raise, each window of the application at the normal window level takes the check window level (NSPopUpMenuWindowLevel, the
// level of the windows of the native checks), so a normal window of another application does not cover it, and each window
// that sp_window_show shows while the state is on takes that level before it is ordered. Without, the windows that the state
// raised and that still stand at that level go back to the normal level, and later windows show at the normal level. The
// windows change level from back to front, and AppKit orders a window that enters a level in front of its peers there, so the
// order among the windows of the application stays. It changes no activation, no key window and no frame, and orders no window
// in. Call it on the main thread.
void sp_windows_raise(bool raise);
