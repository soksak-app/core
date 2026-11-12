// The events of a window (docs/spec/logging.md#entrances): every event that a host registers for a window is the
// event `host.window.event` with the window and the kind, and a resize also with the content size of the window.
package host

import (
	"fmt"
	"os"
)

// windowEventKinds lists the kinds of a window event that RecordWindowEvent stores and the level of each. The movement of a
// window arrives in a stream, so it is at the level `debug`. The kind `resize` carries the content size, so RecordWindowResize
// stores it.
var windowEventKinds = map[string]Level{
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
	// window-active is the host's event that tells the page that the window became active; the host records it when it sends the event.
	"window-active": LevelInfo,
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

// RecordWindowResize stores the window event `resize` of the window with the width and the height of its content in points, read
// when the event arrived and before it is stored. known is false when the content was gone, as that of a window that closed is,
// and the width and the height are then null. The size change of a window arrives in a stream, so it is at the level `debug`.
func RecordWindowResize(window string, width, height float64, known bool) {
	fields := map[string]any{"window": window, "kind": "resize", "width": nil, "height": nil}
	if known {
		fields["width"], fields["height"] = width, height
	}
	EmitHost(LevelDebug, "host.window.event", fields)
}
