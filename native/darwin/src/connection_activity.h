#pragma once

#include <stdbool.h>

// Holds or releases the user-initiated activity of the process (NSActivityUserInitiatedAllowingIdleSystemSleep), which the host
// holds while a connection of its endpoint is open (docs/spec/endpoint.md#transport): the system does not run the process in the
// background (scheduling priority 4) while the activity is held, so the host answers a client whose person waits for it although
// no window of the application is active or shown. A call that requests the current state changes nothing. Any thread may call it.
void sp_connection_activity_hold(bool held);

// Reports whether the activity is held.
bool sp_connection_activity_held(void);
