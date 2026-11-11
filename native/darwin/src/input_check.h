// The windows that a check drives (diagnostic builds call it for diagnostics.drag, docs/spec/endpoint.md#diagnostic-builds).
//
// While a check drives a window, the window takes only the pointer input of the check. Every pointer event of that window that
// reaches -[NSApplication sendEvent:] outside a delivery of input_inject.h is input of a person: a move, a crossing of a tracking
// area, a cursor update, a press, a drag, a release, a scroll or a gesture of the real pointer, also the crossings and cursor
// updates that AppKit makes at the position of the real pointer when the layout under it changes. Such an event is dropped before
// any observer, monitor, gate or view sees it, and counted. A synthetic pointer event that input_inject.h sends through
// -[NSApplication sendEvent:] passes, also when a layout wait of the window kept it and gives it back later; a key event passes.
// While any window is driven, +[NSEvent pressedMouseButtons] and sp_input_person_buttons answer no button of a person, so a
// button that a person holds neither enters a page event nor refuses a synthetic press. A check result therefore does not
// depend on where the real pointer is, which buttons a person holds or whether the application is active.
#include <stdbool.h>
#include <stdint.h>

// Starts the drive of window by a check and reports whether it started; a window that a check already drives answers false and
// stays driven as it was. Main thread.
bool sp_input_check_begin(void *window);

// Ends the drive of window and returns the number of pointer events of a person that the window did not take since its begin;
// a window that no check drives answers 0. Main thread.
uint64_t sp_input_check_end(void *window);

// Whether a check drives window. Main thread.
bool sp_input_check_driven(void *window);

// Whether a check drives any window. Any thread.
bool sp_input_check_any(void);

#ifdef __OBJC__
@class NSEvent;
// Whether event, which reached -[NSApplication sendEvent:], goes on: false for a pointer event of a person in a driven window,
// which this call counts. Main thread.
bool sp_input_check_admits(NSEvent *event);

// Marks event, a synthetic pointer event that a layout wait kept, as it goes back to the event queue, so that it passes when it
// comes back. The queue hands it back as another object with the same content, so the content names it. Main thread.
void sp_input_check_returning(NSEvent *event);
#endif
