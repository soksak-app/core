#include <stdbool.h>

// Result of sp_input_pointer.
typedef enum {
    SP_INPUT_DELIVERED = 0,
    SP_INPUT_REJECTED = 1, // the window, coordinates, phase, or thread is invalid
    SP_INPUT_INACTIVE = 2, // a move without a button while the window is not the key window (WebKit does not update hover for this move), or a key sent to a window that is not the key window of the active application
    SP_INPUT_UNRECEIVED = 3, // the document did not receive the press or release within the timeout, or the scroll target did not render within the timeout
    SP_INPUT_BUTTON_HELD = 4, // AppKit reports a pressed mouse button, so the synthetic press or release was not delivered
    SP_INPUT_PRESS_OPEN = 5, // a synthetic press of that button is still open in that window, so the press was not delivered
} sp_input_result;

// Delivers native input to a window. Coordinates are points relative to the top-left of the content area.
//
// phase: 0 move, 1 press, 2 drag, 3 release, 4 scroll. button: 0 left, 1 right.
// A drag and a release are delivered to the press target of the window and button. A drag or release without a press and a duplicate press are rejected.
sp_input_result sp_input_pointer(void *window, double x, double y, int phase, int button, double deltaX, double deltaY);

// State measured in the same turn that rejected the input with SP_INPUT_BUTTON_HELD. This state alone does not
// identify the cause, so the rejection is reported for the receiver to find the cause.
typedef struct {
    unsigned long long mask; // NSEvent.pressedMouseButtons
    int pid; // pid of the frontmost application; -1 when AppKit does not report a frontmost application
    const char *bundleIdentifier; // bundle identifier of the frontmost application; NULL when absent or when pid is -1
} sp_input_held;

// held is non-NULL only when result is SP_INPUT_BUTTON_HELD, and it is valid only until done returns.
typedef void (*sp_input_done)(void *context, sp_input_result result, const sp_input_held *held);

// Same as sp_input_pointer, except that for a press and a release done is called after the document that owns the gesture
// has received the event. When an input field has focus, WebKit first passes mouse events to the input method
// asynchronously, so a press and a release delivered back to back can be reordered in the document. A scroll is
// delivered after the web view at the coordinates has rendered its current state; a wheel event received before the
// scroll tree of a new document is rendered does not move the document. When no receipt or rendering occurs within
// timeoutSeconds, the result is SP_INPUT_UNRECEIVED. done is called once on the main thread. Call this function on
// the main thread.
void sp_input_pointer_then(void *window, double x, double y, int phase, int button, double deltaX, double deltaY,
    double timeoutSeconds, sp_input_done done, void *context);

// Result of sp_input_activate. A failure identifies the stage at which activation stopped.
typedef enum {
    SP_ACTIVATE_DONE = 0,
    SP_ACTIVATE_REJECTED = 1, // there is no window, or the caller is not on the main thread
    SP_ACTIVATE_REFUSED = 2,  // the application did not become active within the timeout
    SP_ACTIVATE_NOT_KEY = 3,  // the application is active, but the window did not become the key window within the timeout
    SP_ACTIVATE_PENDING = 4,  // the web view of the window did not send its activity state to the web process within the timeout
    SP_ACTIVATE_LOST = 5,     // after the web view sent its activity state, the application is inactive or the window is not the key window
} sp_activate_result;

// When the result is not SP_ACTIVATE_DONE, frontmost is the name of the frontmost application at that time (bundle
// identifier; the display name when there is none; NULL when unknown). It is valid only until done returns.
typedef void (*sp_activate_done)(void *context, sp_activate_result result, const char *frontmost);

// Activates the application and makes the window the key window. After the window is the key window and every web view
// in the window has sent its activity state to the web process, done is called with SP_ACTIVATE_DONE. When this does
// not finish within timeoutSeconds, done is called with the stage at which it stopped. done is called once on the main
// thread. Call this function on the main thread.
void sp_input_activate(void *window, double timeoutSeconds, sp_activate_done done, void *context);

// Activates the application and the window, waits until only the web view at the coordinates reflects the active state, and calls done.
// When the coordinates are on a native surface, only the window activation completes, without waiting for a web view.
void sp_input_activate_at(void *window, double x, double y, double timeoutSeconds, sp_activate_done done, void *context);

// key is a key name (Enter, Tab, Escape, Backspace, ArrowLeft, and so on) or one character. text is the string to
// type; when it is NULL, key is used. modifiers is a bit sum: 1 Shift, 2 Control, 4 Option, 8 Command. down true is a
// press and false is a release.
sp_input_result sp_input_key(void *window, const char *key, const char *text, unsigned modifiers, bool down);
