#pragma once

#include <stdbool.h>

// The value of kCGEventSourceUserData of a key event whose text the caller of sp_input_key stated: that text is what the key
// types, and no input source decides it (docs/spec/exposure.md#virtual-key-window).
#define SP_INPUT_STATED_TEXT 0x736f6b74

// Result of sp_input_pointer.
typedef enum {
    SP_INPUT_DELIVERED = 0,
    SP_INPUT_REJECTED = 1, // the window, coordinates, phase, or thread is invalid
    SP_INPUT_INACTIVE = 2, // a move or key while the application is really active and the window is not its key window (WebKit does not update hover for this move), or a key sent to a window that is not the key window of the active application
    SP_INPUT_UNRECEIVED = 3, // an event ended the wait before the document received the press or release, or before the scroll target or the web views presented
    SP_INPUT_BUTTON_HELD = 4, // AppKit reports a pressed mouse button, so the synthetic press or release was not delivered
    SP_INPUT_PRESS_OPEN = 5, // a press of that button of the pointer is still open, so the press was not delivered
    SP_INPUT_POINTER_HELD = 6, // an open press of another pointer would share the state that the input changes, so it was not delivered
} sp_input_result;

// The pointer of sp_input_pointer and sp_input_pointer_clicks, and of a caller that names no pointer.
#define SP_INPUT_POINTER_MAIN "main"

// The longest name of a pointer. A name has 1 to SP_INPUT_POINTER_NAME_MAX characters of a-z, 0-9 and -.
#define SP_INPUT_POINTER_NAME_MAX 32

// Delivers native input of the pointer SP_INPUT_POINTER_MAIN to a window. Coordinates are points relative to the top-left of the
// content area.
//
// phase: 0 move, 1 press, 2 drag, 3 release, 4 scroll. button: 0 left, 1 right.
//
// Each named pointer holds one open press of each button: the window, the view that received the press (its target) and the
// origin of the press. A drag and a release are delivered to the press target of the pointer and button, in the window of that
// press. A drag or release without a press of the pointer in the window is rejected, and a press of a button whose press the
// pointer holds is rejected with SP_INPUT_PRESS_OPEN, in any window. The real cursor never moves.
//
// While the input of a pointer is delivered, +[NSEvent pressedMouseButtons] answers the buttons of that pointer, so a page sees the
// buttons of its own gesture; outside a delivery it answers the buttons of every pointer. AppKit and WebKit keep some state once
// per window, page or application, and an input that would share such state with the open press of another pointer is rejected
// with SP_INPUT_POINTER_HELD (docs/spec/exposure.md#named-pointers):
// - a press on a page (the web view that contains the target, or the target view) that another pointer holds pressed;
// - a press of a window that passes presses through -[NSApplication sendEvent:] while another pointer holds a press in the window,
//   because AppKit keeps one target of each button in a window and the press first moves the hover of the window;
// - a move in a window in which another pointer holds a press, because a window has one hover position;
// - a move, press, drag or release while another pointer holds a press, when the input method of the system serves the page of
//   either (the key window of the application that is really active, with an editable focus): the input method answers after
//   the delivery has returned, and WebKit reads the buttons outside the delivery of the pointer.
sp_input_result sp_input_pointer(void *window, double x, double y, int phase, int button, double deltaX, double deltaY);

// The largest click count of a press and a release: a person's triple click.
#define SP_INPUT_CLICKS_MAX 3

// Same as sp_input_pointer, of the pointer SP_INPUT_POINTER_MAIN, for a press or a release whose event has the click count clicks, 1 to SP_INPUT_CLICKS_MAX. AppKit gives the
// second press of a person's double click a count of 2, and WebKit makes the dblclick event from that count. Another count is rejected.
sp_input_result sp_input_pointer_clicks(void *window, double x, double y, int phase, int button, int clicks);

// The mask of the buttons that a person holds. While a synthetic press is open, +[NSEvent pressedMouseButtons] also has
// the button of that press, as sp_input_pointer states, because WebKit reads the buttons of a page event from there. Native code that decides by what
// a person holds reads this function. Before the first delivered press the two values are the same value of AppKit.
unsigned long sp_input_physical_buttons(void);

// The buttons that a person holds as input of this application may read them: none while a virtual key window is open
// (input_virtual.h), whose pages never see a real button.
unsigned long sp_input_person_buttons(void);

// State of a rejection with SP_INPUT_BUTTON_HELD or SP_INPUT_POINTER_HELD.
//
// For SP_INPUT_BUTTON_HELD it is measured in the same turn that rejected the input. This state alone does not identify the
// cause, so the rejection is reported for the receiver to find the cause; pointer and reason are NULL.
// For SP_INPUT_POINTER_HELD, pointer names the pointer whose open press rejected the input and reason states the shared state;
// mask is 0, pid is -1 and bundleIdentifier is NULL.
typedef struct {
    unsigned long long mask; // NSEvent.pressedMouseButtons
    int pid; // pid of the frontmost application; -1 when AppKit does not report a frontmost application
    const char *bundleIdentifier; // bundle identifier of the frontmost application; NULL when absent or when pid is -1
    const char *pointer; // the pointer that holds the press
    const char *reason; // the state that the press of that pointer holds
} sp_input_held;

// held is non-NULL only when result is SP_INPUT_BUTTON_HELD or SP_INPUT_POINTER_HELD, and it is valid only until done returns.
typedef void (*sp_input_done)(void *context, sp_input_result result, const sp_input_held *held);

// Same as sp_input_pointer, except that for a press and a release done is called after the document that owns the gesture
// has received the event. When an input field has focus, WebKit first passes mouse events to the input method
// asynchronously, so a press and a release delivered back to back can be reordered in the document. A scroll is
// delivered after the web view at the coordinates has rendered its current state; a wheel event received before the
// scroll tree of a new document is rendered does not move the document. No wait has a limit (docs/spec/exposure.md#methods): a
// press or a release ends at its receipt, at the end of the handling by WebKit without the receipt, at the end of the input
// registration of its web view, at the close of its window, at the report that its web process stopped answering, and on the
// path of the input method at the next press or key event of the application; a scroll and a move that waits for the virtual key
// window end at their presentation or at the same ends of their web views. Each end without the event answers SP_INPUT_UNRECEIVED,
// and a scroll into a window that is minimized or not shown answers it in its turn. clicks is the click count of a press or a
// release, as in sp_input_pointer_clicks. pointer is the name of the pointer; a name that is NULL or not of the form of
// SP_INPUT_POINTER_NAME_MAX is rejected. done is called once on the main thread. Call this function on the main thread.
void sp_input_pointer_then(void *window, const char *pointer, double x, double y, int phase, int button, double deltaX,
    double deltaY, int clicks, sp_input_done done, void *context);

// Result of sp_input_activate. A failure identifies the stage at which activation stopped.
typedef enum {
    SP_ACTIVATE_DONE = 0,
    SP_ACTIVATE_REJECTED = 1, // there is no window, or the caller is not on the main thread
    SP_ACTIVATE_REFUSED = 2,  // the application did not become active before an event ended the step
    SP_ACTIVATE_NOT_KEY = 3,  // the application is active, but the window did not become the key window or cannot become it
    SP_ACTIVATE_PENDING = 4,  // the web views of the window did not send their activity state before an event ended the step
    SP_ACTIVATE_LOST = 5,     // the application or the window lost activation before or after the web views sent their activity state
} sp_activate_result;

// When the result is not SP_ACTIVATE_DONE, frontmost is the name of the frontmost application at that time (bundle
// identifier; the display name when there is none; NULL when unknown). It is valid only until done returns.
typedef void (*sp_activate_done)(void *context, sp_activate_result result, const char *frontmost);

// Activates the application and makes the window the key window. After the window is the key window and every web view
// in the window has sent its activity state to the web process, done is called with SP_ACTIVATE_DONE. No step has a limit
// (docs/spec/exposure.md#methods). macOS answers a granted request with a notification and a refused one with no event, so the
// activation step and the key window step end at their notification, at the next press or key event that the application receives
// or at the close of the window, and the key window step also when another window becomes key. The web view step ends when every
// web view reported, when the application or the window loses activation (SP_ACTIVATE_LOST), and at the close of the window, the end
// of the input registration of a web view or the report that its process stopped answering (SP_ACTIVATE_PENDING). A window that
// cannot become the key window or is minimized is refused in its turn with SP_ACTIVATE_NOT_KEY. done is called once on the main
// thread. Call this function on the main thread.
void sp_input_activate(void *window, sp_activate_done done, void *context);

// Activates the application and the window, waits until only the web view at the coordinates reflects the active state, and calls done.
// When the coordinates are on a native surface, only the window activation completes, without waiting for a web view.
void sp_input_activate_at(void *window, double x, double y, sp_activate_done done, void *context);

// key is a key name (Enter, Tab, Escape, Backspace, ArrowLeft, and so on) or one character. text is the string to
// type; when it is NULL, key is used. modifiers is a bit sum: 1 Shift, 2 Control, 4 Option, 8 Command. down true is a
// press and false is a release.
sp_input_result sp_input_key(void *window, const char *key, const char *text, unsigned modifiers, bool down);
