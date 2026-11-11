// The virtual key window: one window of this process that answers as the key and main window inside the application, and
// the application answers as active, while the system key window and the front application stay where a person left them.
//
// WebKit updates hover and page focus only for a page of the key window of an active application, and input of the host must
// not take those from a person. The replaced methods answer the virtual state, so a press, a release and a key of the virtual
// key window pass -[NSApplication sendEvent:] as a person's do and the local monitors see them; a move goes to the tracking
// areas of the window directly, so the system cursor and the real pointer stay where they are.
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

// Delivers event, a key down of a named key or with a text that the caller stated (SP_INPUT_STATED_TEXT of input_inject.h), to
// window, the virtual key window, when the text input client that holds its keyboard is a web view, and reports whether it did.
// The input method of the system does not serve the window, so the web view takes the key without its input context: it inserts
// a stated text through its text input and runs the command of the key binding of a named key. Another client, such as an image
// region, takes the key itself and is not served here. Main thread.
bool sp_input_virtual_send_key_to_web_view(void *window, void *event);

// Whether input of window passes -[NSApplication sendEvent:]: the application is really active and window is its key window.
// AppKit also holds a key window in an application that is not active, such as a window that a host shows while another window
// is the virtual key window; its input is input of an application that is not active and goes to the window or the view.
bool sp_input_virtual_through_application(void *window);

// The text input client that holds the keyboard of window: the nearest view from its first responder up that takes marked text
// and inserted text (NSTextInputClient), or NULL. Main thread.
void *sp_input_virtual_text_client(void *window);
