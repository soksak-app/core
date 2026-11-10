#include <stdbool.h>
#include <sys/types.h>

typedef void (*sp_process_exit_done)(void *context, bool exited);

// Passes exited true to done when the process with pid ends. A process that no longer exists has ended. The wait uses the
// process exit notification of the kernel (kqueue NOTE_EXIT) and has no limit: only that notification or
// sp_process_exit_end ends it. Call on the main thread; done is called once on the main thread.
void sp_process_when_exited(pid_t pid, sp_process_exit_done done, void *context);

// Ends the wait that sp_process_when_exited registered with context and has not answered: done is called with exited false
// before this returns. A wait that answered already is left alone. Call on the main thread.
void sp_process_exit_end(void *context);
