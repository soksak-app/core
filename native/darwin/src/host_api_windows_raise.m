// Native implementation of the host binding helper of the raise of the windows of the application (diagnostics.windows.raise).
#include "host_api_windows_raise.h"

#include <stdbool.h>
#include "main_thread.h"
#include "window_reveal.h"

// The native call runs on the main thread (main_thread.h).
void main_sp_windows_raise(bool raise) {
    hostRunOnMain(^{ sp_windows_raise(raise); });
}
