#include "host_api_system.h"

#include <stdbool.h>
#include "window_facts.h"
#include "main_thread.h"

// The native call runs on the main thread (main_thread.h).
bool main_sp_application_active(void) { return ON_MAIN(bool, sp_application_active()); }
