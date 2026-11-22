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
	return f.runReadRows(caller, session, nil, nil)
}

// runReadRows calls Read with the raw from and count members of core.session.read, nil for an absent member.
func (f *ownedFixture) runReadRows(caller, session string, from, count json.RawMessage) (json.RawMessage, error) {
	f.t.Helper()
	var screen json.RawMessage
	var got error
	answered := false
	f.sessions.Read(caller, session, from, count, func(body json.RawMessage, err error) {
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

// A refusal of the sidecar that states its rule and reason reaches the caller with them, so the person reads why the input was
// refused (docs/spec/plugins.md#owned-sessions).
func TestARefusedInputNamesTheRuleAndReasonOfTheSidecar(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"error": "guardRefused", "rule": "untracked", "reason": "the line is not followed"}
	}
	err := f.run(func(answer func(error)) { f.sessions.Input("owner-tab", "s-1", "\r", answer) })
	if err == nil || err.Error() != "guardRefused: untracked: the line is not followed" {
		t.Fatalf("the refusal is %v, want guardRefused: untracked: the line is not followed", err)
	}
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

// A read with from and count asks the sidecar for those retained rows and answers its reply {from, count, rows} unchanged
// (docs/spec/plugins.md#owned-sessions).
func TestReadWithFromAndCountReturnsTheRetainedRowsOfTheSidecar(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"from": body["from"], "count": body["count"], "rows": []any{"$ ls", "README.md"}}
	}
	screen, err := f.runReadRows("owner-tab", "s-1", json.RawMessage(`120`), json.RawMessage(`2`))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(screen, &got); err != nil {
		t.Fatalf("rows: %v", err)
	}
	equal(t, got, map[string]any{"from": float64(120), "count": float64(2), "rows": []any{"$ ls", "README.md"}})
	sends := f.host.sent()
	equal(t, len(sends), 1)
	equal(t, sends[0].body, map[string]any{"operation": "read", "session": "s-1", "from": float64(120), "count": float64(2)})
}

// Invalid from and count are refused with the text of the page before any sidecar request (docs/spec/plugins.md#owned-sessions).
func TestReadRefusesInvalidFromAndCountBeforeARequest(t *testing.T) {
	cases := []struct {
		from, count json.RawMessage
		want        string
	}{
		{json.RawMessage(`0`), nil, "core.session.read from and count are required together"},
		{nil, json.RawMessage(`1`), "core.session.read from and count are required together"},
		{json.RawMessage(`-1`), json.RawMessage(`1`), "core.session.read from must be an integer of 0 or more"},
		{json.RawMessage(`1.5`), json.RawMessage(`1`), "core.session.read from must be an integer of 0 or more"},
		{json.RawMessage(`"0"`), json.RawMessage(`1`), "core.session.read from must be an integer of 0 or more"},
		{json.RawMessage(`null`), json.RawMessage(`1`), "core.session.read from must be an integer of 0 or more"},
		{json.RawMessage(`9007199254740992`), json.RawMessage(`1`), "core.session.read from must be an integer of 0 or more"},
		{json.RawMessage(`0`), json.RawMessage(`0`), "core.session.read count must be an integer from 1 to 200"},
		{json.RawMessage(`0`), json.RawMessage(`201`), "core.session.read count must be an integer from 1 to 200"},
		{json.RawMessage(`0`), json.RawMessage(`2.5`), "core.session.read count must be an integer from 1 to 200"},
	}
	for _, c := range cases {
		f := newOwnedFixture(t)
		openFixtureSession(t, f)
		_, err := f.runReadRows("owner-tab", "s-1", c.from, c.count)
		if err == nil || err.Error() != c.want {
			t.Fatalf("read of from %s and count %s: error = %v, want %s", c.from, c.count, err, c.want)
		}
		equal(t, len(f.host.sent()), 0)
	}
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
