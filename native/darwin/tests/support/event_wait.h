// The waits of the native checks (docs/spec/verification.md): a wait runs the run loop of the main thread until its condition
// holds and judges the condition again after each source that the run loop handled, such as a block of the main queue, an event
// of the window server, a display link, a notification or a key-value change that such a source delivers, and the wake of
// eventWake. A wait has no limit: the limit of the case ends a wait whose event does not come. A condition that a timer or
// another thread changes calls eventWake after the change, because neither of them ends a turn of the run loop.
#import <Foundation/Foundation.h>

/// Wakes the wait of the main thread so it judges its condition again. Any thread may call it.
void eventWake(void);

/// Runs the run loop of the main thread until done returns YES, and dispatches each application event that arrives meanwhile.
/// what names the event that the wait waits for; it is written once as `WAIT <what>` when the wait does not end at once, so the
/// output of a case that its limit ended names the wait. Only the main thread waits.
void eventWait(NSString *what, BOOL (^done)(void));
