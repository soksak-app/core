// The windows of a person for the native checks: a second process of the check binary shows windows that belong to another
// application, as the windows of a person do, without taking the front, the key window or the activation. A check covers its own
// window with such a window, so the cover changes nothing of the state of its own application (key, main, active), and judges
// that an order of its own windows leaves the order of the windows of the person as it was.
//
// The check calls sp_person_child first in main; in the second process it runs the person and returns its exit status, and in the
// check it returns -1. Each request writes one line to the person and reads one line back; a read ends with the answer or with the
// end of the person process, so no request waits without an end.
#import <Cocoa/Cocoa.h>

/// Runs the person when argv names it (the second process) and returns its exit status; returns -1 in the check.
int sp_person_child(int argc, char **argv);

/// Starts the person from the executable at path (argv[0] of the check). Returns NO and writes the reason to stderr when the
/// person does not start.
BOOL sp_person_start(const char *path);

/// Shows a window of the person with the frame in AppKit screen coordinates and the sRGB fill rgb, behind every window of the
/// screen, and returns its window number once the window server lists it, or -1 with the reason written to stderr.
long sp_person_window(NSRect frame, uint32_t rgb);

/// Orders the window number of the person directly above target (any window number), commits the order and returns YES once
/// the window server has it, or NO with the reason written to stderr.
BOOL sp_person_order_above(long number, long target);

/// Closes the window number of the person and returns YES once it is gone, or NO with the reason written to stderr.
BOOL sp_person_close(long number);

/// Whether the person application is active, as it reports itself (NSRunningApplication), or -1 when it does not answer.
int sp_person_active(void);

/// The process identifier of the person, or 0 before it starts.
pid_t sp_person_pid(void);

/// Ends the person by the end of its standard input and waits for its exit. Returns YES when it exited with status 0 and the
/// window server lists no window of it, so no window of the person stays on the screen of the person who uses the machine; NO
/// with the reason written to stderr otherwise. A check that ends without this call closes the pipe too, which ends the person.
BOOL sp_person_end(void);
