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

// contract: debug.follow.notices-only-following-windows
//
// The delivery of a notice is a step of the main thread of a window, so a window whose view does not follow the event files
// receives none: a window follows from the call debugFollow {following: true} until the call with false.
func TestANoticeReachesOnlyTheWindowsThatFollow(t *testing.T) {
	h, windows, calls := followFixture()
	notice := LogNotice{Path: "logs/host-b1.jsonl", Size: 10, Notices: 1}
	h.announceLogNotice(notice)
	follow(t, h, calls[0], `{"following":true}`)
	h.announceLogNotice(notice)
	follow(t, h, calls[0], `{"following":false}`)
	h.announceLogNotice(notice)
	if windows[0].notices != 1 || windows[1].notices != 0 {
		t.Fatalf("window-a received %d notices and window-b %d, want 1 while window-a followed and 0", windows[0].notices, windows[1].notices)
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

// contract: debug.follow.notices-only-following-windows
//
// A page that reports ready is a new document, which has not asked to follow the event files, so the ready of its window
// (readyWindow, the start of windowReady) ends the following of that window and of no other.
func TestAReadyPageStartsNotFollowing(t *testing.T) {
	h, windows, calls := followFixture()
	follow(t, h, calls[0], `{"following":true}`)
	follow(t, h, calls[1], `{"following":true}`)
	s, err := h.readyWindow(calls[0])
	if err != nil {
		t.Fatalf("the ready of window-a: %v", err)
	}
	if s != h.windows[windows[0].id] {
		t.Fatal("the ready of window-a returned another window")
	}
	h.announceLogNotice(LogNotice{Path: "logs/host-b1.jsonl", Size: 10, Notices: 1})
	if windows[0].notices != 0 || windows[1].notices != 1 {
		t.Fatalf("window-a received %d notices and window-b %d after the ready of window-a, want 0 and 1", windows[0].notices, windows[1].notices)
	}
}
