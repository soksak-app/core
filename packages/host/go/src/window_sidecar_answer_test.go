package host

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// windowAnswerFixture returns the persistent service of the project and the surfaces that send to it from a window. The surface
// window-surface has no view, so a window send reaches the service.
func windowAnswerFixture(t *testing.T) (*Surfaces, *sidecar) {
	t.Helper()
	s, service, _ := mountedSidecarProject(t)
	service.persistent = true
	s.sidecars.awaited = map[awaitKey]chan awaitedReply{}
	s.sidecars.dropped = map[awaitKey]bool{}
	s.sidecars.declarations.Lock()
	s.sidecars.persistent[service.name] = true
	s.sidecars.declarations.Unlock()
	return s, service
}

// contract: sidecars-transport.answer.resolves-with-matching-reply
func TestWindowSidecarAnswerResolvesWithTheMatchingReply(t *testing.T) {
	s, service := windowAnswerFixture(t)
	const surface = "window-surface"
	cids := []string{"window-cid-1"}
	request := json.RawMessage(`{"operation":"resize","session":"s1","cols":80,"rows":24}`)
	type result struct {
		body json.RawMessage
		err  error
	}
	done := make(chan result, 1)
	go func() {
		body, err := s.sidecars.awaitSend(context.Background(), service.name, surface, cids, func() error {
			return s.windowSidecarSend(context.Background(), service.name, surface, request, cids)
		})
		done <- result{body, err}
	}()
	line := receiveLine(t, service)
	var sent struct {
		Surface string   `json:"surface"`
		Cids    []string `json:"cids"`
	}
	if err := json.Unmarshal(line.bytes, &sent); err != nil {
		t.Fatalf("window send line: %v", err)
	}
	if sent.Surface != surface || len(sent.Cids) != 1 || sent.Cids[0] != "window-cid-1" {
		t.Fatalf("window send line = %+v", sent)
	}
	if violation, handled := s.sidecars.handlePersistentLine(service, []byte(`{"surface":"window-surface","cids":["window-cid-1"],"body":{"session":"s1","cols":80,"rows":24}}`)); handled {
		t.Fatalf("reply: %s", violation)
	}
	got := receiveAnswer(t, done)
	if got.err != nil {
		t.Fatalf("window answered send: %v", got.err)
	}
	if string(got.body) != `{"session":"s1","cols":80,"rows":24}` {
		t.Fatalf("reply body = %s", got.body)
	}
}

// contract: sidecars-transport.answer.refuses-without-cids-or-persistent
func TestWindowSidecarAnswerRefusesWithoutCidsAndSendsNothing(t *testing.T) {
	s, service := windowAnswerFixture(t)
	_, err := s.sidecars.awaitSend(context.Background(), service.name, "window-surface", nil, func() error {
		return s.windowSidecarSend(context.Background(), service.name, "window-surface", json.RawMessage(`{"operation":"end","session":"s1"}`), nil)
	})
	if err == nil || err.Error() != "sidecarSend answer requires cids" {
		t.Fatalf("answer without cids = %v", err)
	}
	if len(service.outbox) != 0 {
		t.Fatalf("a refused answer queued %d lines", len(service.outbox))
	}
}

// contract: sidecars.window-send.mounted-view-surface-is-refused
func TestWindowSendToAMountedSurfaceNamesTheViewSend(t *testing.T) {
	s, service, _ := mountedSidecarProject(t)
	err := s.windowSidecarSend(context.Background(), service.name, "probe-surface", json.RawMessage(`{"operation":"resize"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "requires viewSidecarSend") {
		t.Fatalf("window send to a mounted surface = %v", err)
	}
}
