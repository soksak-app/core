#include <stdbool.h>
#include <sys/types.h>

typedef void (*sp_process_exit_done)(void *context, bool exited);

// Passes exited true to done when the process with pid ends, and exited false when it does not end within seconds. A
// process that no longer exists has ended. The wait uses the process exit notification of the kernel (kqueue NOTE_EXIT).
// Call on the main thread; done is called once on the main thread.
void sp_process_when_exited(pid_t pid, double seconds, sp_process_exit_done done, void *context);
