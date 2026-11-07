// Records the activity of the application and of its windows as events of the ring of the process
// (docs/spec/logging.md#entrances).
#pragma once
#include <stdbool.h>

// Installs the observers of the notifications of the application (activation, hiding), of its windows (key, main, occlusion,
// miniaturization) and of the input source. Each notification is one event `native.app.<kind>`, `native.window.<kind>` or
// `native.input.source_changed` at the level info. A second call installs nothing more. Any thread may call it.
void sp_observe_activity(void);

// Whether the process-lifetime activation notification observer was successfully installed. This query
// never installs observers. A zero activation count is evidence only when this returns true. Any thread.
bool sp_activity_activation_registered(void);
