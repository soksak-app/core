// Records the activity of the application and of its windows as events of the ring of the process
// (docs/spec/logging.md#automatic-entrances).
#pragma once

// Installs the observers of the notifications of the application (activation, hiding), of its windows (key, main, occlusion,
// miniaturization) and of the input source. Each notification is one event `native.app.<kind>`, `native.window.<kind>` or
// `native.input.source_changed` at the level info. A second call installs nothing more. Any thread may call it.
void sp_observe_activity(void);
