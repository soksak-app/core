package host

// The owned sessions of the persistent services (docs/spec/persistent-services.md#owned-sessions): the service answers the request
// `sessions` with the sessions that it holds for the client, and an answered send resolves with the reply that names its surface and
// correlation identifiers (docs/spec/persistent-services.md#owned-session-messages).

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// sessionsFixture returns a connected persistent service of the name fixture-service, whose requests the test reads from its outbox.
func sessionsFixture(t *testing.T) (*Sidecars, *sidecar) {
	t.Helper()
	declaration := SidecarDeclaration{Name: "fixture-service", Folder: t.TempDir(), Version: "0.0.1",
		Data: []byte(`{"executable":"service","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}`)}
	c, err := NewSidecars([]SidecarDeclaration{declaration}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	process := &sidecar{name: declaration.Name, persistent: true, outbox: make(chan queuedLine, 4),
		closeWaiters: map[string]chan error{}, listed: map[string]json.RawMessage{}, surfaces: map[string]bool{}}
	c.stopped = false
	c.running[process.name] = process
	return c, process
}

// receiveLine returns the next line that the host queued for process; a line that never comes fails the test.
func receiveLine(t *testing.T, process *sidecar) queuedLine {
	t.Helper()
	select {
	case line := <-process.outbox:
		return line
	case <-time.After(5 * time.Second):
		t.Fatal("the host queued no line for the sidecar")
	}
	return queuedLine{}
}

// receiveAnswer returns the answer of a call that runs in its own goroutine; an answer that never comes fails the test.
func receiveAnswer[T any](t *testing.T, done <-chan T) T {
	t.Helper()
	select {
	case got := <-done:
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("the call did not answer")
	}
	var zero T
	return zero
}

// answerSessions starts Sessions for the fixture service and feeds it the answer line that answer builds from the request identifier.
func answerSessions(t *testing.T, c *Sidecars, process *sidecar, answer func(request string) string) (json.RawMessage, error) {
	t.Helper()
	type result struct {
		sessions json.RawMessage
		err      error
	}
	done := make(chan result, 1)
	go func() {
		sessions, err := c.OwnedSessions("fixture-service")
		done <- result{sessions, err}
	}()
	var request struct {
		Operation string `json:"operation"`
		Request   string `json:"request"`
	}
	if err := json.Unmarshal(receiveLine(t, process).bytes, &request); err != nil {
		t.Fatalf("request line: %v", err)
	}
	if request.Operation != "sessions" {
		t.Fatalf("the request operation is %q, want sessions", request.Operation)
	}
	if violation, handled := c.handlePersistentLine(process, []byte(answer(request.Request))); handled {
		t.Fatalf("sessions answer: %s", violation)
	}
	got := receiveAnswer(t, done)
	return got.sessions, got.err
}

// contract: sidecars-transport.sessions.returns-service-sessions
func TestSessionsReturnsTheSessionsOfTheService(t *testing.T) {
	c, process := sessionsFixture(t)
	sessions, err := answerSessions(t, c, process, func(request string) string {
		return `{"operation":"sessions","request":"` + request + `","ok":true,"sessions":[{"session":"s1","surface":"tab-a","root":"/work","creation":"c1","size":{"width":640,"height":384,"scale":2},"plugin":"terminal","program":"working"}]}`
	})
	if err != nil {
		t.Fatalf("Sessions: %v", err)
	}
	if want := `[{"session":"s1","surface":"tab-a","root":"/work","creation":"c1","size":{"width":640,"height":384,"scale":2},"plugin":"terminal","program":"working"}]`; string(sessions) != want {
		t.Fatalf("Sessions = %s, want %s", sessions, want)
	}
}

// contract: sidecars-transport.sessions.fails-with-service-error
func TestSessionsRejectsAFailedAnswerWithItsError(t *testing.T) {
	c, process := sessionsFixture(t)
	_, err := answerSessions(t, c, process, func(request string) string {
		return `{"operation":"sessions","request":"` + request + `","ok":false,"error":"owner list is unavailable"}`
	})
	if err == nil || err.Error() != "owner list is unavailable" {
		t.Fatalf("Sessions error = %v, want the error of the answer", err)
	}
}

// contract: sidecars-transport.sessions.ends-with-connection
func TestSessionsEndsWithItsConnection(t *testing.T) {
	c, process := sessionsFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := c.OwnedSessions("fixture-service")
		done <- err
	}()
	var request struct {
		Request string `json:"request"`
	}
	if err := json.Unmarshal(receiveLine(t, process).bytes, &request); err != nil {
		t.Fatalf("request line: %v", err)
	}
	c.mu.Lock()
	waiter := process.closeWaiters[request.Request]
	delete(process.closeWaiters, request.Request)
	c.mu.Unlock()
	waiter <- errServiceDisconnected
	if err := receiveAnswer(t, done); err == nil || err.Error() != "the service connection ended before the answer" {
		t.Fatalf("Sessions error = %v", err)
	}
}

// contract: sidecars-transport.sessions.refuses-an-entry-without-plugin
func TestSessionsRefusesAnEntryWithoutPlugin(t *testing.T) {
	c, process := sessionsFixture(t)
	_, err := answerSessions(t, c, process, func(request string) string {
		return `{"operation":"sessions","request":"` + request + `","ok":true,"sessions":[{"session":"s1","surface":"tab-a","root":"/work","creation":"c1","size":{"width":640,"height":384,"scale":2}}]}`
	})
	if err == nil || err.Error() != "invalid message: sessions plugin is not a non-empty string" {
		t.Fatalf("Sessions error = %v", err)
	}
}

// contract: sidecars-transport.sessions.refuses-an-invalid-program
func TestSessionsRefusesAnEntryWithAnInvalidProgram(t *testing.T) {
	for _, program := range []string{`"done"`, `{"state":"idle"}`, ``} {
		c, process := sessionsFixture(t)
		member := ""
		if program != "" {
			member = `,"program":` + program
		}
		_, err := answerSessions(t, c, process, func(request string) string {
			return `{"operation":"sessions","request":"` + request + `","ok":true,"sessions":[{"session":"s1","surface":"tab-a","root":"/work","creation":"c1","size":{"width":640,"height":384,"scale":2},"plugin":"terminal"` + member + `}]}`
		})
		if err == nil || err.Error() != "invalid message: sessions program is not idle, working, blocked or null" {
			t.Fatalf("Sessions error for program %q = %v", program, err)
		}
	}
}

// contract: sidecars-transport.sessions.refuses-a-size-that-is-not-an-object
func TestSessionsRefusesASizeThatIsNotAnObject(t *testing.T) {
	c, process := sessionsFixture(t)
	_, err := answerSessions(t, c, process, func(request string) string {
		return `{"operation":"sessions","request":"` + request + `","ok":true,"sessions":[{"session":"s1","surface":"tab-a","root":"/work","creation":"c1","size":80,"plugin":"terminal"}]}`
	})
	if err == nil || err.Error() != "invalid message: sessions size is not an object" {
		t.Fatalf("Sessions error = %v", err)
	}
}

// contract: sidecars-transport.sessions.refuses-invalid-member
func TestSessionsRefusesAnEntryWhoseSizeIsNotPositive(t *testing.T) {
	c, process := sessionsFixture(t)
	_, err := answerSessions(t, c, process, func(request string) string {
		return `{"operation":"sessions","request":"` + request + `","ok":true,"sessions":[{"session":"s1","surface":"tab-a","root":"/work","creation":"c1","size":{"width":0,"height":384,"scale":2},"plugin":"terminal"}]}`
	})
	if err == nil || err.Error() != "invalid message: sessions size.width is not a positive number" {
		t.Fatalf("Sessions error = %v", err)
	}
}

// contract: sidecars-transport.sessions.empty-without-endpoint
func TestSessionsOfAServiceWithoutEndpointIsEmptyAndStartsNothing(t *testing.T) {
	declaration := SidecarDeclaration{Name: "fixture-service", Folder: t.TempDir(), Version: "0.0.1",
		Data: []byte(`{"executable":"service","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}`)}
	c, err := NewSidecars([]SidecarDeclaration{declaration}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := c.OwnedSessions("fixture-service")
	if err != nil || string(sessions) != "[]" {
		t.Fatalf("Sessions = %s, %v; want []", sessions, err)
	}
	if _, running := c.running["fixture-service"]; running {
		t.Fatal("Sessions started a service without an endpoint")
	}
}

// contract: sidecars-transport.sessions.refuses-empty-sidecar
func TestSessionsRefusesAnEmptySidecarName(t *testing.T) {
	c, _ := sessionsFixture(t)
	if _, err := c.OwnedSessions(""); err == nil || err.Error() != "sidecarSessions requires a non-empty sidecar" {
		t.Fatalf("Sessions error = %v", err)
	}
}

// contract: sidecars-transport.sessions.refuses-standard-io-sidecar
func TestSessionsRefusesASidecarThatIsNotAPersistentService(t *testing.T) {
	c, process := sessionsFixture(t)
	process.persistent = false
	if _, err := c.OwnedSessions("fixture-service"); err == nil || err.Error() != "sidecar fixture-service is not a persistent service" {
		t.Fatalf("Sessions error = %v", err)
	}
	if len(process.outbox) != 0 {
		t.Fatalf("a standard-I/O sidecar received %d requests", len(process.outbox))
	}
}

// awaitFixture starts an answered send of body with the identifiers cids from the owner surface tab-owner of the fixture service.
func awaitFixture(t *testing.T, c *Sidecars, cids []string, body json.RawMessage) (<-chan json.RawMessage, <-chan error) {
	t.Helper()
	owner := sidecarSessionSurfaces(t)
	c.owners["tab-owner"] = owner
	c.roots["tab-owner"] = "/work"
	bodies := make(chan json.RawMessage, 1)
	errs := make(chan error, 1)
	go func() {
		answer, err := c.awaitSend(context.Background(), "fixture-service", "tab-owner", cids, func() error {
			return c.SendWithCids(owner, "fixture-service", "tab-owner", body, cids)
		})
		bodies <- answer
		errs <- err
	}()
	return bodies, errs
}

// contract: sidecars-transport.answer.resolves-with-matching-reply
// contract: sidecars-transport.owned-messages.forwarded-unchanged
func TestAnsweredSendResolvesWithTheMatchingReplyAndForwardsTheBodyUnchanged(t *testing.T) {
	c, process := sessionsFixture(t)
	bodies, errs := awaitFixture(t, c, []string{"cid-1"}, json.RawMessage(`{"operation":"open","session":{"creation":"c1"},"cols":80,"rows":24,"params":{}}`))
	var request struct {
		Surface string          `json:"surface"`
		Root    string          `json:"root"`
		Cids    []string        `json:"cids"`
		Body    json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(receiveLine(t, process).bytes, &request); err != nil {
		t.Fatalf("send line: %v", err)
	}
	if request.Surface != "tab-owner" || request.Root != "/work" || len(request.Cids) != 1 || request.Cids[0] != "cid-1" {
		t.Fatalf("send request = %+v", request)
	}
	if string(request.Body) != `{"operation":"open","session":{"creation":"c1"},"cols":80,"rows":24,"params":{}}` {
		t.Fatalf("the body was changed: %s", request.Body)
	}
	if violation, handled := c.handlePersistentLine(process, []byte(`{"surface":"tab-owner","cids":["cid-1"],"body":{"session":"s1","creation":"c1"}}`)); handled {
		t.Fatalf("reply: %s", violation)
	}
	if err := receiveAnswer(t, errs); err != nil {
		t.Fatalf("awaitSend: %v", err)
	}
	if body := receiveAnswer(t, bodies); string(body) != `{"session":"s1","creation":"c1"}` {
		t.Fatalf("reply body = %s", body)
	}
}

// contract: sidecars-transport.answer.rejects-with-error-body
func TestAnsweredSendRejectsWithTheErrorOfTheReplyBody(t *testing.T) {
	c, process := sessionsFixture(t)
	_, errs := awaitFixture(t, c, []string{"cid-3"}, json.RawMessage(`{"operation":"end","session":"s9"}`))
	receiveLine(t, process)
	if violation, handled := c.handlePersistentLine(process, []byte(`{"surface":"tab-owner","cids":["cid-3"],"body":{"error":"session s9 is not open"}}`)); handled {
		t.Fatalf("reply: %s", violation)
	}
	if err := receiveAnswer(t, errs); err == nil || err.Error() != "session s9 is not open" {
		t.Fatalf("awaitSend error = %v, want the error of the reply body", err)
	}
}

// contract: sidecars-transport.answer.refuses-without-cids-or-persistent
func TestAnsweredSendRefusesWithoutCidsOrAPersistentService(t *testing.T) {
	c, process := sessionsFixture(t)
	owner := sidecarSessionSurfaces(t)
	c.owners["tab-owner"] = owner
	c.roots["tab-owner"] = "/work"
	send := func(name string, cids []string) error {
		_, err := c.awaitSend(context.Background(), name, "tab-owner", cids, func() error {
			return c.SendWithCids(owner, name, "tab-owner", json.RawMessage(`{}`), cids)
		})
		return err
	}
	if err := send("fixture-service", nil); err == nil || err.Error() != "sidecarSend answer requires cids" {
		t.Fatalf("send without cids = %v", err)
	}
	if err := send("fixture-stdio", []string{"cid-4"}); err == nil || err.Error() != "sidecarSend answer requires a persistent sidecar" {
		t.Fatalf("send to a standard-I/O sidecar = %v", err)
	}
	if len(process.outbox) != 0 {
		t.Fatalf("a refused send queued %d lines", len(process.outbox))
	}
}

// contract: sidecars-transport.answer.refuses-waiting-duplicate-cids
func TestAnsweredSendRefusesCidsThatAlreadyWait(t *testing.T) {
	c, process := sessionsFixture(t)
	_, errs := awaitFixture(t, c, []string{"cid-5"}, json.RawMessage(`{"operation":"resize"}`))
	receiveLine(t, process)
	owner := sidecarSessionSurfaces(t)
	_, err := c.awaitSend(context.Background(), "fixture-service", "tab-owner", []string{"cid-5"}, func() error {
		return c.SendWithCids(owner, "fixture-service", "tab-owner", json.RawMessage(`{}`), []string{"cid-5"})
	})
	if err == nil || err.Error() != "sidecarSend answer cids already wait for surface tab-owner" {
		t.Fatalf("duplicate send = %v", err)
	}
	if len(process.outbox) != 0 {
		t.Fatalf("the duplicate send queued %d lines", len(process.outbox))
	}
	c.failAwaited("fixture-service", errAnswerEnded)
	receiveAnswer(t, errs)
}

// contract: sidecars-transport.answer.refuses-invalid-cids
func TestAnsweredSendRefusesAnIdentifierThatALineCannotHold(t *testing.T) {
	c, process := sessionsFixture(t)
	_, errs := awaitFixture(t, c, []string{"bad\"cid"}, json.RawMessage(`{}`))
	err := receiveAnswer(t, errs)
	if err == nil || !strings.HasPrefix(err.Error(), "sidecarSend cids are refused:") {
		t.Fatalf("send with an invalid identifier = %v", err)
	}
	if len(process.outbox) != 0 {
		t.Fatalf("the refused send queued %d lines", len(process.outbox))
	}
}

// contract: sidecars-transport.answer.ends-with-connection
func TestAnsweredSendEndsWithTheConnectionOfItsService(t *testing.T) {
	c, process := sessionsFixture(t)
	_, errs := awaitFixture(t, c, []string{"cid-6"}, json.RawMessage(`{}`))
	receiveLine(t, process)
	c.failAwaited("fixture-service", errAnswerEnded)
	if err := receiveAnswer(t, errs); err == nil || err.Error() != "the service connection ended before the answer" {
		t.Fatalf("awaitSend error = %v", err)
	}
}
