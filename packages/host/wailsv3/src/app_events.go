// The events of the application (docs/spec/logging.md#automatic-entrances): every event that a host registers for the
// application is the event `host.app.event` with the kind.
package host

import (
	"fmt"
	"os"
)

// appEventKinds lists the kinds of an application event. A host stores the kinds its framework reports.
var appEventKinds = map[string]bool{
	"started": true, "activated": true, "deactivated": true, "reopened": true, "exit_requested": true, "exit": true,
}

// RecordAppEvent stores an application event of the kind. A kind outside appEventKinds is reported on the standard error and
// nothing is stored.
func RecordAppEvent(kind string) {
	if !appEventKinds[kind] {
		fmt.Fprintf(os.Stderr, "event writer: the application event kind %q is not declared\n", kind)
		return
	}
	EmitHost(LevelInfo, "host.app.event", map[string]any{"kind": kind})
}
