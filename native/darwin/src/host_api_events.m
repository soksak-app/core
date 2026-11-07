#include "host_api_events.h"

#include <stdlib.h>
#include "event_ring.h"
#include "activity_observers.h"
#include "observe.h"
#include "main_thread.h"

// The event ring, its clock and the observation counters need no thread; the registration of the activity observers uses
// AppKit and runs on the main thread (main_thread.h).
void main_sp_observe_activity(void) { hostRunOnMain(^{ sp_observe_activity(); }); }
