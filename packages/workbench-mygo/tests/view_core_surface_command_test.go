// A view call of a core command that runs on the surface of its caller runs on the surface of the view, on a shell of the
// native workbench (docs/spec/plugins.md#owned-sessions, docs/spec/native-surfaces.md#view-surfaces).
package workbench_test

import (
	"encoding/json"
	"testing"
)

// A view that calls core.session.end, a core command of the surface of its caller that this fixture registers as a recorder,
// runs it on its own surface.
func TestAViewCallOfACoreSurfaceCommandRunsOnTheSurfaceOfTheView(t *testing.T) {
	r := newViewRelayWith(t, &surfaceHost{}, installedDocument)
	surface := r.surface()
	var ran string
	r.f.shell.Registry().CommandLaterOnSurface("core.session.end", func(_ json.RawMessage, on string, answer func(any, error)) {
		ran = on
		answer(map[string]any{"surface": on}, nil)
	})
	reply := viewCall(t, r.f, r.stored, surface, "core.session.end", map[string]any{})
	if reply["error"] != nil || ran != surface {
		t.Fatalf("the reply is %v and the command ran on %q, want it to run on the surface %q of the view", reply, ran, surface)
	}
}
