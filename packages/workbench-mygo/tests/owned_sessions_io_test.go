// The owner's input, submit and read of an owned session, and the program state that the sidecar reports to the owner
// (docs/spec/plugins.md#owned-sessions, docs/spec/persistent-services.md#owned-session-messages).
package workbench_test

import (
	"encoding/json"
	"testing"
)

// runRead calls Read of the owned sessions, runs the steps it posted, and returns the screen and the error that Read answered.
func (f *ownedFixture) runRead(caller, session string) (json.RawMessage, error) {
	f.t.Helper()
	var screen json.RawMessage
	var got error
	answered := false
	f.sessions.Read(caller, session, func(body json.RawMessage, err error) {
		screen, got, answered = body, err, true
	})
	f.pending.drain(f.t)
	if !answered {
		f.t.Fatal("read did not answer")
	}
	return screen, got
}

func TestInputByAnotherSurfaceIsRefusedBeforeARequest(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	err := f.run(func(answer func(error)) { f.sessions.Input("other-tab", "s-1", "ls", answer) })
	if err == nil || err.Error() != "session s-1 is owned by owner-tab" {
		t.Fatalf("input error = %v", err)
	}
	equal(t, len(f.host.sent()), 0)
}

func TestInputByTheOwnerSendsTheTextAsGiven(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": body["session"]}
	}
	if err := f.run(func(answer func(error)) { f.sessions.Input("owner-tab", "s-1", "ls\r", answer) }); err != nil {
		t.Fatalf("input: %v", err)
	}
	sends := f.host.sent()
	equal(t, len(sends), 1)
	equal(t, sends[0].surface, "owner-tab")
	equal(t, sends[0].body, map[string]any{"operation": "input", "session": "s-1", "text": "ls\r"})
}

func TestSubmitRefusesTextWithALineEndBeforeAnyRequest(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	err := f.run(func(answer func(error)) { f.sessions.Submit("owner-tab", "s-1", "ls\n", answer) })
	if err == nil || err.Error() != "core.session.submit text must not contain CR or LF" {
		t.Fatalf("submit error = %v", err)
	}
	equal(t, len(f.host.sent()), 0)
}

func TestSubmitByTheOwnerPastesTheTextThenSendsEnter(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": body["session"]}
	}
	if err := f.run(func(answer func(error)) { f.sessions.Submit("owner-tab", "s-1", "ls", answer) }); err != nil {
		t.Fatalf("submit: %v", err)
	}
	sends := f.host.sent()
	equal(t, len(sends), 2)
	equal(t, sends[0].body, map[string]any{"operation": "paste", "session": "s-1", "text": "ls"})
	equal(t, sends[1].body, map[string]any{"operation": "input", "session": "s-1", "text": "\r"})
}

func TestReadByAnotherSurfaceIsRefusedBeforeARequest(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	_, err := f.runRead("other-tab", "s-1")
	if err == nil || err.Error() != "session s-1 is owned by owner-tab" {
		t.Fatalf("read error = %v", err)
	}
	equal(t, len(f.host.sent()), 0)
}

func TestReadByTheOwnerReturnsTheScreenOfTheSidecar(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"rows": []any{"$ ls", "README.md"}, "cursor": map[string]any{"row": 1, "column": 0}}
	}
	screen, err := f.runRead("owner-tab", "s-1")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(screen, &got); err != nil {
		t.Fatalf("screen: %v", err)
	}
	equal(t, got, map[string]any{"rows": []any{"$ ls", "README.md"}, "cursor": map[string]any{"row": float64(1), "column": float64(0)}})
	sends := f.host.sent()
	equal(t, len(sends), 1)
	equal(t, sends[0].body, map[string]any{"operation": "read", "session": "s-1"})
}

func TestSessionProgressSetsTheProgramStateOfTheOwnersSession(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.surfaceMessage("owner-tab", `{"event":"session.program","session":"s-1","state":"working"}`)
	equal(t, f.sessions.Status()[0]["program"], map[string]any{"state": "working"})
	f.surfaceMessage("owner-tab", `{"event":"session.program","session":"s-1","state":"idle"}`)
	equal(t, f.sessions.Status()[0]["program"], map[string]any{"state": "idle"})
	equal(t, f.failures, []string(nil))
}

func TestSessionProgressWithAnInvalidStateIsLoggedAndChangesNothing(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.surfaceMessage("owner-tab", `{"event":"session.program","session":"s-1","state":"busy"}`)
	equal(t, f.failures, []string{"core.session.program: invalid session.program body: state"})
	equal(t, f.sessions.Status()[0]["program"], nil)
}

func TestSessionProgressOfAnotherOwnerIsRefused(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": "s-2", "creation": body["session"].(map[string]any)["creation"]}
	}
	if _, err := f.open("other-tab", "terminal", `{}`, cardSize); err != nil {
		t.Fatalf("open of the other owner: %v", err)
	}
	f.surfaceMessage("owner-tab", `{"event":"session.program","session":"s-2","state":"working"}`)
	equal(t, f.failures, []string{"core.session.program s-2: surface owner-tab does not own session s-2"})
	equal(t, f.sessions.Status()[1]["program"], nil)
}

func TestAcceptedProgressChangePublishesTheEvent(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.surfaceMessage("owner-tab", `{"event":"session.program","session":"s-1","state":"working"}`)
	f.surfaceMessage("owner-tab", `{"event":"session.program","session":"s-1","state":"idle"}`)
	equal(t, f.eventsNamed("workbench.session.program"), []map[string]any{{"session": "s-1", "state": "working"}, {"session": "s-1", "state": "idle"}})
}

func TestRepeatedProgressStateChangesNothingAndPublishesNothing(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.surfaceMessage("owner-tab", `{"event":"session.program","session":"s-1","state":"working"}`)
	f.surfaceMessage("owner-tab", `{"event":"session.program","session":"s-1","state":"working"}`)
	equal(t, f.failures, []string(nil))
	equal(t, len(f.eventsNamed("workbench.session.program")), 1)
}

func TestRefusedProgressReportPublishesNothing(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.surfaceMessage("owner-tab", `{"event":"session.program","session":"s-1","state":"busy"}`)
	f.surfaceMessage("owner-tab", `{"event":"session.program","session":"s-9","state":"idle"}`)
	equal(t, len(f.failures), 2)
	equal(t, len(f.eventsNamed("workbench.session.program")), 0)
}
