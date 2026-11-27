// A tab of core.layout.apply whose params name an owned session shows that session, as a tab of core.layout.open does
// (docs/spec/plugins.md#owned-sessions): the session must be open, and the new tab becomes the showing tab of core.sessions.
package workbench_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// sessionPlugins holds the plugin term, which declares sessions and one sidecar, and whose tabs take the session in their params.
const sessionPlugins = `{"plugins": [
	{"id": "term", "package": "@scope/plugin-term", "version": "1.0.0", "folder": "/installed/plugin", "manifest": {"id": "term", "name": "Term", "description": "term", "mark": "t", "icon": "<path d=\"M1 1h14\"/>",
		"surface": {"composition": {"kind": "view", "page": "ui/index.html"}, "params": {"type": "object", "properties": {"session": {"type": "string"}}}},
		"dependencies": {"` + sessionSidecar + `": "1.0.0"}, "sessions": true}}
]}`

// sessionApplyShell is a window with the card main holding the owner tab tab-owner of term, and the session s-1 that tab-owner opened.
func sessionApplyShell(t *testing.T) (*tabShell, *ownedHost) {
	t.Helper()
	owned := &ownedHost{reply: func(op string, body map[string]any) map[string]any {
		if op == "open" {
			return map[string]any{"session": "s-1", "creation": body["session"].(map[string]any)["creation"]}
		}
		return map[string]any{"session": body["session"], "size": body["size"]}
	}}
	f := newTabShell(t, &storedHost{installed: sessionPlugins, extra: owned.table(),
		projects: []map[string]any{gridProject(oneCard(tab("tab-owner", "term")))}})
	f.open(t)
	var opened any
	var failure error
	f.shell.Registry().RunLaterOn("core.session.open", json.RawMessage(`{"plugin":"term","params":{},"size":{"width":640,"height":384,"scale":2}}`),
		"tab-owner", func(value any, err error) { opened, failure = value, err })
	f.settle()
	if failure != nil {
		t.Fatalf("core.session.open: %v", failure)
	}
	if text, _ := json.Marshal(opened); string(text) != `{"session":"s-1"}` {
		t.Fatalf("core.session.open answered %s", text)
	}
	return f, owned
}

func TestALayoutApplyTabThatNamesASessionShowsIt(t *testing.T) {
	f, owned := sessionApplyShell(t)
	before := len(owned.sent())
	applied, err := f.plan("core.layout.apply", `{"tree":{"direction":"row","children":[{"tabs":[{"tab":"tab-owner"}]},{"tabs":[{"plugin":"term","params":{"session":"s-1"}}]}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	shown := *applied.Cards[1].Tabs[0].Tab
	equal(t, f.status("core.sessions"), `[{"owner":"tab-owner","params":{},"plugin":"term","program":null,"session":"s-1","shownBy":"`+shown+`"}]`)
	// The showing tab gives the session the size of its card at once.
	sent := owned.sent()[before:]
	if len(sent) != 1 || sent[0].body["operation"] != "resize" || sent[0].body["session"] != "s-1" {
		t.Fatalf("the apply sent %+v, want one resize of s-1", sent)
	}
}

func TestALayoutApplyRefusesATabThatNamesASessionThatIsNotOpen(t *testing.T) {
	f, _ := sessionApplyShell(t)
	_, err := f.plan("core.layout.apply", `{"tree":{"direction":"row","children":[{"tabs":[{"tab":"tab-owner"}]},{"tabs":[{"plugin":"term","params":{"session":"s-9"}}]}]}}`)
	if err == nil || !strings.Contains(err.Error(), "session s-9 is not open") {
		t.Fatalf("the apply answered %v, want the refusal of s-9", err)
	}
	equal(t, f.status("core.sessions"), `[{"owner":"tab-owner","params":{},"plugin":"term","program":null,"session":"s-1","shownBy":null}]`)
}

// A card that has no measured frame, such as a card that a fullscreen card hides, gives the session that its tab shows no size and
// raises no error; the session takes the size of the card when the card has a measured frame again (docs/spec/plugins.md#owned-sessions).
func TestACardWithoutAMeasuredFrameSendsNoSizeAndRaisesNoError(t *testing.T) {
	f, owned := sessionApplyShell(t)
	applied, err := f.plan("core.layout.apply", `{"tree":{"direction":"row","children":[{"tabs":[{"tab":"tab-owner"}]},{"tabs":[{"plugin":"term","params":{"session":"s-1"}}]}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	owner := *applied.Cards[0].Card
	before := len(owned.sent())
	f.run(t, "core.card.fullscreen", `{"card":"`+owner+`"}`)
	// The owner gives the session another size while its card is hidden, so the measured card has a size to send.
	var failure error
	f.shell.Registry().RunLaterOn("core.session.resize", json.RawMessage(`{"session":"s-1","size":{"width":100,"height":100,"scale":2}}`),
		"tab-owner", func(_ any, err error) { failure = err })
	f.settle()
	if failure != nil {
		t.Fatalf("core.session.resize: %v", failure)
	}
	before = len(owned.sent())
	for _, sent := range owned.sent()[before:] {
		t.Errorf("the hidden card sent %+v", sent.body)
	}
	for _, written := range f.host.written("workbench.record.error") {
		t.Errorf("the hidden card raised %v", written)
	}
	f.run(t, "core.card.fullscreen", `{"card":"`+owner+`"}`)
	sent := owned.sent()[before:]
	if len(sent) != 1 || sent[0].body["operation"] != "resize" {
		t.Fatalf("the measured card sent %+v, want one resize", sent)
	}
	if size := sent[0].body["size"].(map[string]any); size["width"] != applied.Cards[1].Frame.Width {
		t.Fatalf("the measured card sent the size %v, want the width %v", size, applied.Cards[1].Frame.Width)
	}
}

// resizeFromOwner runs core.session.resize of s-1 from tab-owner without a call of its view and returns the answer.
func resizeFromOwner(f *tabShell, width int) error {
	var failure error
	f.shell.Registry().RunLaterOn("core.session.resize", json.RawMessage(`{"session":"s-1","size":{"width":`+strconv.Itoa(width)+`,"height":100,"scale":2}}`),
		"tab-owner", func(_ any, err error) { failure = err })
	f.settle()
	return failure
}

// A request for an owner surface on which the host mounted a view goes through that view with the source generation that the event
// view-source-registered names, whether or not the view has called the workbench, and the host refuses no request
// (docs/spec/persistent-services.md#owned-session-messages).
func TestARequestForAMountedOwnerGoesThroughItsViewSource(t *testing.T) {
	f, owned := sessionApplyShell(t)
	owned.mount("tab-owner", 7)
	f.shell.Event("view-source-registered", []any{map[string]any{"plugin": "term", "surface": "tab-owner", "generation": 7}})
	f.settle()
	if err := resizeFromOwner(f, 100); err != nil {
		t.Fatalf("core.session.resize: %v", err)
	}
	sent := owned.viewSent()
	if len(sent) != 1 || sent[0].surface != "tab-owner" || sent[0].generation != 7 || sent[0].body["operation"] != "resize" {
		t.Fatalf("the view sent %+v, want one resize of tab-owner with generation 7", sent)
	}
	for _, written := range f.host.written("workbench.record.error") {
		t.Errorf("the request raised %v", written)
	}
	// The end of the view source sends the next request through the window.
	owned.unmount("tab-owner")
	f.shell.Event("view-source-ended", []any{map[string]any{"plugin": "term", "surface": "tab-owner", "generation": 7}})
	f.settle()
	before := len(owned.sent())
	if err := resizeFromOwner(f, 200); err != nil {
		t.Fatalf("core.session.resize after the end of the view: %v", err)
	}
	if window := owned.sent()[before:]; len(window) != 1 || window[0].body["operation"] != "resize" {
		t.Fatalf("the window sent %+v, want one resize", window)
	}
	if len(owned.viewSent()) != 1 {
		t.Fatalf("the ended view sent %+v", owned.viewSent()[1:])
	}
}

// A request for a tab whose placement has not finished waits for the mount of its view: it goes through the view with the generation of
// view-source-registered, and the host refuses no request (docs/spec/persistent-services.md#owned-session-messages).
func TestARequestBeforeTheMountOfItsOwnerWaitsForTheMount(t *testing.T) {
	var mu sync.Mutex
	var hold *gate
	owned := &ownedHost{reply: func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": "s-2", "creation": body["session"].(map[string]any)["creation"]}
	}}
	extra := owned.table()
	extra["presentSurfaces"] = func(context.Context, json.RawMessage) (any, error) {
		mu.Lock()
		waiting := hold
		mu.Unlock()
		if waiting != nil {
			waiting.wait()
		}
		return []any{}, nil
	}
	f := newTabShell(t, &storedHost{installed: sessionPlugins, extra: extra,
		projects: []map[string]any{gridProject(oneCard(tab("tab-owner", "term")))}})
	f.open(t)
	release := newGate()
	mu.Lock()
	hold = release
	mu.Unlock()
	f.shell.Registry().RunLater("core.layout.open", json.RawMessage(`{"card":"main","side":"right","plugin":"term"}`), func(_ any, err error) {
		if err != nil {
			t.Errorf("core.layout.open: %v", err)
		}
	})
	f.settle()
	var surfaces []struct{ Surface string }
	if err := json.Unmarshal([]byte(f.status("core.surfaces")), &surfaces); err != nil {
		t.Fatal(err)
	}
	opened := ""
	for _, item := range surfaces {
		if item.Surface != "tab-owner" {
			opened = item.Surface
		}
	}
	if opened == "" {
		t.Fatalf("core.surfaces holds no opened tab: %s", f.status("core.surfaces"))
	}
	owned.mount(opened, 9)
	var session any
	var failure error
	answered := false
	f.shell.Registry().RunLaterOn("core.session.open", json.RawMessage(`{"plugin":"term","params":{},"size":{"width":640,"height":384,"scale":2}}`),
		opened, func(value any, err error) { session, failure, answered = value, err, true })
	f.settle()
	if answered || len(owned.sent()) != 0 || len(owned.viewSent()) != 0 {
		t.Fatalf("the open before the mount answered %v %v and sent %+v %+v", session, failure, owned.sent(), owned.viewSent())
	}
	f.shell.Event("view-source-registered", []any{map[string]any{"plugin": "term", "surface": opened, "generation": 9}})
	f.settle()
	release.open()
	f.settle()
	if failure != nil || !answered {
		t.Fatalf("core.session.open answered %v, %v", answered, failure)
	}
	sent := owned.viewSent()
	if len(sent) != 1 || sent[0].surface != opened || sent[0].generation != 9 || sent[0].body["operation"] != "open" {
		t.Fatalf("the view sent %+v, want one open of %s with generation 9", sent, opened)
	}
}

// A restart of the window whose restored tab names a session that the service no longer holds states the session that did not
// return, records it in the log and shows no view for that tab (docs/spec/plugins.md#owned-sessions, F1190).
func TestARestartWithATabWhoseSessionEndedRecordsItAndShowsNoView(t *testing.T) {
	owned := &ownedHost{}
	stale := tab("tab-stale", "term")
	stale["params"] = map[string]any{"session": "s-missing"}
	// startFails: the start shows the error of the restored tab, which the case waits for instead of auditing the start.
	stored := &storedHost{installed: sessionPlugins, extra: owned.table(), startFails: true,
		projects: []map[string]any{gridProject(oneCard(stale))}}
	f := newTabShell(t, stored)
	records := stored.written("workbench.record.error")
	if len(records) != 1 {
		t.Fatalf("the restart wrote %d record errors, want 1: %v", len(records), records)
	}
	fields := records[0]["fields"].(map[string]any)
	equal(t, fields["where"], "restored tab tab-stale")
	equal(t, fields["text"], `the session s-missing of tab "tab-stale" ended before the restart`)
	for _, sent := range owned.sent() {
		if sent.surface == "tab-stale" {
			t.Fatalf("the tab whose session ended was sent %+v", sent)
		}
	}
	equal(t, f.status("core.sessions"), `[]`)
}
