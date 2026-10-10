// The events of a window (docs/spec/logging.md#automatic-entrances): every event that a host registers for a window is the
// event `host.window.event` with the window and the kind.
package host

import (
	"fmt"
	"os"
)

// windowEventKinds lists the kinds of a window event and the level of each. The movement and the size change of a window
// arrive in streams, so they are at the level `debug`.
var windowEventKinds = map[string]Level{
	"resize":               LevelDebug,
	"move":                 LevelDebug,
	"scale_factor_changed": LevelDebug,
	"show":                 LevelInfo,
	"hide":                 LevelInfo,
	"occlusion_changed":    LevelInfo,
	"focus":                LevelInfo,
	"lost_focus":           LevelInfo,
	"close_requested":      LevelInfo,
	"closed":               LevelInfo,
	"web_process_ended":    LevelInfo,
	"navigation_committed": LevelInfo,
}

// RecordWindowEvent stores a window event of the kind for the window. A kind outside windowEventKinds is reported on the
// standard error and nothing is stored.
func RecordWindowEvent(window, kind string) {
	level, ok := windowEventKinds[kind]
	if !ok {
		fmt.Fprintf(os.Stderr, "event writer: the window event kind %q is not declared\n", kind)
		return
	}
	EmitHost(level, "host.window.event", map[string]any{"window": window, "kind": kind})
}
