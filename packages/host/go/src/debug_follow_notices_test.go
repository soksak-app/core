package host

import (
	"context"
	"encoding/json"
	"testing"
)

// followWindow is the main page of a window of the follow tests: notices counts the host events `debug-log-changed` it received.
type followWindow struct {
	frontendRecord
	id      uint
	notices int
}

func (w *followWindow) ID() uint { return w.id }

func (w *followWindow) Emit(name string, data ...any) {
	if name == "debug-log-changed" {
		w.notices++
	}
}

// followFixture returns a host of the two windows "window-a" and "window-b" and the context of a host call of each.
func followFixture() (*Host, [2]*followWindow, [2]context.Context) {
	h := &Host{windows: map[uint]*Surfaces{}, endpoint: &Endpoint{}}
	var windows [2]*followWindow
	var calls [2]context.Context
	for index, name := range []string{"window-a", "window-b"} {
		windows[index] = &followWindow{id: uint(index + 1)}
		h.windows[windows[index].id] = &Surfaces{name: name, host: h, window: windows[index], ready: true}
		calls[index] = WithFrontend(context.Background(), windows[index])
	}
	return h, windows, calls
}

// follow runs the host call debugFollow of a window with the JSON request.
func follow(t *testing.T, h *Host, call context.Context, request string) {
	t.Helper()
	if err := h.DebugFollow(call, json.RawMessage(request)); err != nil {
		t.Fatalf("debugFollow %s: %v", request, err)
	}
}

// contract: debug.follow.refuses-a-request-without-a-boolean
func TestDebugFollowRefusesARequestWithoutABoolean(t *testing.T) {
	h, _, calls := followFixture()
	for _, c := range []struct{ request, want string }{
		{`{}`, "argument request.following is missing"},
		{`{"following":null}`, "argument request.following is missing"},
		{`{"following":"yes"}`, "argument request.following must be a boolean, not a string"},
	} {
		if err := h.DebugFollow(calls[0], json.RawMessage(c.request)); err == nil || err.Error() != c.want {
			t.Errorf("debugFollow %s = %v, want %q", c.request, err, c.want)
		}
	}
}
