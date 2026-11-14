// The virtual key window: one window of this process that answers as the key and main window inside the application, and
// the application answers as active, while the system key window and the front application stay where a person left them.
//
// WebKit updates hover and page focus only for a page of the key window of an active application, and input of the host must
// not take those from a person. The replaced methods answer the virtual state, so a press, a release and a key of the virtual
// key window pass -[NSApplication sendEvent:] as a person's do and the local monitors see them; a move goes to the tracking
// areas of the window directly, so the system cursor and the real pointer stay where they are.
//
// While the application answers as active, a request of the application to make another window key (makeKeyWindow,
// makeKeyAndOrderFront:) moves the virtual key window there, as it makes that window key in an active application, so a host
// that shows or focuses a window hears the change of the key window as from a person's activation.
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
// The location of the system pointer in screen coordinates, which +[NSEvent mouseLocation] answers while no virtual key window
// holds an injected point.
void sp_input_virtual_real_mouse_location(double *x, double *y);

// The cursor of the virtual key window. While it answers, the pointer of the application is its injected point:
// +[NSEvent mouseLocation] answers that point in screen coordinates, and +[NSWindow windowNumberAtPoint:belowWindowWithWindowNumber:]
// answers the window for it, so WebKit sets the cursor of the page under it. -[NSCursor set] keeps the cursor for the window
// instead of passing it to the system, and +[NSCursor currentCursor] answers it, so the cursor of a person does not change.
//
// Sets the cursor of the cursor rect of the deepest view under x, y, in window coordinates, of window, the virtual key window, and
// reports whether a cursor rect holds the point. Each view from the view at the point up to the content view answers
// resetCursorRects into a collection instead of AppKit, so the rects of the window that AppKit keeps do not change. Main thread.
bool sp_input_virtual_cursor_rect(void *window, double x, double y);
// The name of the cursor that the application set for window while it is the virtual key window: arrow, pointingHand, iBeam,
// openHand, closedHand, crosshair, resizeLeftRight, resizeUpDown, columnResize, rowResize, operationNotAllowed or other; NULL
// when window is not the virtual key window or no cursor was set for it. The string is valid until the turn ends. Main thread.
const char *sp_input_virtual_cursor(void *window);
// Calls changed on the main thread each time the cursor that the application set for window as the virtual key window changes,
// and returns the observation that sp_input_virtual_end_cursor_observation ends once; NULL without a window or a callback. The
// observation refers to the window weakly. Main thread.
#ifdef __BLOCKS__
void *sp_input_virtual_observe_cursor(void *window, void (^changed)(void));
#endif
void sp_input_virtual_end_cursor_observation(void *observation);

// Delivers event, a key down of a named key or with a text that the caller stated (SP_INPUT_STATED_TEXT of input_inject.h), to
// window, the virtual key window, when the text input client that holds its keyboard is a web view, and reports whether it did.
// The input method of the system does not serve the window, so the web view takes the key without its input context: it inserts
// a stated text through its text input and runs the command of the key binding of a named key. Another client, such as an image
// region, takes the key itself and is not served here. *inputContextAbsent, when given, tells whether the input context of the web view
// was nil before and after the key, which is how the key stays away from the input method. Main thread.
bool sp_input_virtual_send_key_to_web_view(void *window, void *event, bool *inputContextAbsent);

// Whether input of window passes -[NSApplication sendEvent:]: the application is really active and window is its key window.
// AppKit also holds a key window in an application that is not active, such as a window that a host shows while another window
// is the virtual key window; its input is input of an application that is not active and goes to the window or the view.
bool sp_input_virtual_through_application(void *window);

// The text input client that holds the keyboard of window: the nearest view from its first responder up that takes marked text
// and inserted text (NSTextInputClient), or NULL. Main thread.
void *sp_input_virtual_text_client(void *window);
