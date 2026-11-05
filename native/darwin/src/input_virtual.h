// The virtual key window: one window of this process that answers as the key and main window inside the application, and
// the application answers as active, while the system key window and the front application stay where a person left them.
//
// WebKit updates hover and page focus only for a page of the key window of an active application, and a check must not take
// those from a person. AppKit keeps its own state, so input of a virtual key window is delivered to the window or the view,
// never through -[NSApplication sendEvent:]: that path reads the real state and drops a key and a first click.
#include <stdbool.h>

// Makes window the virtual key window and reports whether it is. The application that is really active answers false: real
// state wins and no state is mixed. The first entry replaces the methods; an application that never enters has none replaced.
// Another virtual key window ends first. Call it on the main thread.
bool sp_input_virtual_enter(void *window);

// Ends the virtual state with one event that names reason. Without a virtual key window it does nothing. Main thread.
void sp_input_virtual_end(const char *reason);

// Whether window is the virtual key window of an application that is not really active.
bool sp_input_virtual_is(void *window);

// Whether any window is the virtual key window. Any thread.
bool sp_input_virtual_any(void);

// Records the point of the last injected input of the virtual key window, in window coordinates.
void sp_input_virtual_set_point(void *window, double x, double y);

// The point of the last injected input of the virtual key window; false when window is not it or no input carried a point.
bool sp_input_virtual_point(void *window, double *x, double *y);

// What AppKit itself answers, also while the methods are replaced. A record of system state reads these.
bool sp_input_virtual_real_active(void);
bool sp_input_virtual_real_key(void *window);
