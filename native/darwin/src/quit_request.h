#include <stdbool.h>

// Installs the handler for the quit request of the operating system (kAEQuitApplication Apple event: Dock quit, log out,
// restart, quit from another program). The handler holds the event and calls request on the main thread. The host
// finishes saving and, just before it ends, replies to the held event without an error with sp_quit_request_answer.
// Install only once; a second installation returns false. Call on the main thread after the application has finished launching (after finishLaunching).
bool sp_quit_request_install(void (^request)(void));

// Replies without an error to every held quit request event. Does nothing when no event is held. Call on the main thread.
void sp_quit_request_answer(void);

// Answers every suspended quit request event with userCanceledErr, so the sender (the Dock, a logout, another program)
// learns that the application did not quit because a window keeps a modified tab. Does nothing without a suspended
// event. Call it on the main thread.
void sp_quit_request_cancel(void);
