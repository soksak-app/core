package host

import (
	"errors"
	"reflect"
	"testing"
)

// The page receives the first responder at its ready and then at each change, and a page that is not ready receives none.
// contract: window.responder.sent-at-ready-and-on-each-change
func TestTheResponderEventFollowsTheFirstResponderAfterThePageIsReady(t *testing.T) {
	var state responderState
	surface := "tab-view"
	current := &responderEvent{Owner: "page"}
	ready := false
	var sent []responderEvent
	read := func() (*responderEvent, error) { copied := *current; return &copied, nil }
	emit := func(event *responderEvent) { sent = append(sent, *event) }
	send := func(force bool) {
		t.Helper()
		if err := state.send(force, func() bool { return ready }, read, emit, func(error) bool { return false }); err != nil {
			t.Fatalf("send: %v", err)
		}
	}
	send(false)
	if len(sent) != 0 {
		t.Fatalf("a page that is not ready received %v", sent)
	}
	ready = true
	send(true)
	current = &responderEvent{Owner: "surface", Surface: &surface}
	send(false)
	send(false)
	send(true)
	want := []responderEvent{{Owner: "page"}, {Owner: "surface", Surface: &surface}, {Owner: "surface", Surface: &surface}}
	if !reflect.DeepEqual(sent, want) {
		t.Fatalf("sent %+v, want the ready value, one value for the change and the value at the next ready %+v", sent, want)
	}
	failed := errors.New("window facts missing responder")
	if err := state.send(false, func() bool { return true }, func() (*responderEvent, error) { return nil, failed }, emit, func(error) bool { return false }); !errors.Is(err, failed) {
		t.Fatalf("a failed read returned %v", err)
	}
}

// The view of a view surface is registered as the document "" of its surface, and a first responder in it is the owner
// surface with that surface and no document; a first responder in a document region is the owner document.
// contract: window.responder.view-is-owner-surface
func TestTheFirstResponderInTheViewOfAViewSurfaceIsOwnerSurface(t *testing.T) {
	named := map[uint64]string{10: "tab-view"}
	documents := map[uint64]DocumentKey{20: {Surface: "tab-view", Name: viewRegionName}, 30: {Surface: "tab-view", Name: "page"}}
	text := func(value string) *string { return &value }
	view := windowResponder("WKWebView", 20, 10, false, named, documents, 0)
	if want := (WindowResponder{Class: "WKWebView", Owner: "surface", Surface: text("tab-view")}); !reflect.DeepEqual(view, want) {
		t.Fatalf("view responder %+v, want %+v", view, want)
	}
	region := windowResponder("WKWebView", 30, 10, false, named, documents, 0)
	if want := (WindowResponder{Class: "WKWebView", Owner: "document", Surface: text("tab-view"), Document: text("page")}); !reflect.DeepEqual(region, want) {
		t.Fatalf("region responder %+v, want %+v", region, want)
	}
}

// A read that fails because the window closed sends nothing and is no error: the close removed the page that the event goes to.
// A read that fails while the window is open is the error of the read.
// contract: window.responder.closed-window-sends-nothing
func TestAResponderChangeOfAClosedWindowSendsNothing(t *testing.T) {
	var state responderState
	gone := errors.New("window closed")
	var sent []responderEvent
	emit := func(event *responderEvent) { sent = append(sent, *event) }
	closed := func(err error) bool { return errors.Is(err, gone) }
	if err := state.send(true, func() bool { return true }, func() (*responderEvent, error) { return nil, gone }, emit, closed); err != nil || len(sent) != 0 {
		t.Fatalf("a closed window returned %v and sent %v", err, sent)
	}
	failed := errors.New("window facts missing responder")
	if err := state.send(true, func() bool { return true }, func() (*responderEvent, error) { return nil, failed }, emit, closed); !errors.Is(err, failed) {
		t.Fatalf("a failed read of an open window returned %v", err)
	}
}
