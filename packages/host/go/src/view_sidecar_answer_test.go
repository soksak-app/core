package host

import (
	"context"
	"encoding/json"
	"testing"
)

// answerViewFixture returns the mounted view of probe-surface with its service, which is a persistent service that answers its requests.
func answerViewFixture(t *testing.T) (*Surfaces, *sidecar, uint64) {
	t.Helper()
	s, service, _ := mountedSidecarProject(t)
	service.persistent = true
	s.sidecars.awaited = map[awaitKey]chan awaitedReply{}
	s.sidecars.dropped = map[awaitKey]bool{}
	s.sidecars.declarations.Lock()
	s.sidecars.persistent[service.name] = true
	s.sidecars.declarations.Unlock()
	view, ok := s.documents.view("probe-surface")
	if !ok {
		t.Fatal("fixture has no mounted view")
	}
	return s, service, view.generation
}

// contract: sidecars.view-answer.resolves-with-the-matching-reply
func TestViewSidecarAnswerResolvesWithTheMatchingReply(t *testing.T) {
	s, service, generation := answerViewFixture(t)
	request := ViewSidecarSendRequest{Source: "probe-surface", Generation: generation, Sidecar: service.name, Surface: "probe-surface",
		Body: json.RawMessage(`{"operation":"resize","session":"s1","cols":80,"rows":24}`), Cids: []string{"view-cid-1"}, Answer: true}
	type result struct {
		body json.RawMessage
		err  error
	}
	done := make(chan result, 1)
	go func() {
		body, err := s.answerViewSidecar(context.Background(), request)
		done <- result{body, err}
	}()
	line := receiveLine(t, service)
	var sent struct {
		Surface string   `json:"surface"`
		Cids    []string `json:"cids"`
	}
	if err := json.Unmarshal(line.bytes, &sent); err != nil {
		t.Fatalf("view send line: %v", err)
	}
	if sent.Surface != "probe-surface" || len(sent.Cids) != 1 || sent.Cids[0] != "view-cid-1" {
		t.Fatalf("view send line = %+v", sent)
	}
	if violation, handled := s.sidecars.handlePersistentLine(service, []byte(`{"surface":"probe-surface","cids":["view-cid-1"],"body":{"session":"s1","cols":80,"rows":24}}`)); handled {
		t.Fatalf("reply: %s", violation)
	}
	got := receiveAnswer(t, done)
	if got.err != nil {
		t.Fatalf("answerViewSidecar: %v", got.err)
	}
	if string(got.body) != `{"session":"s1","cols":80,"rows":24}` {
		t.Fatalf("reply body = %s", got.body)
	}
}

// contract: sidecars.view-answer.requires-cids
func TestViewSidecarAnswerRefusesWithoutCids(t *testing.T) {
	s, service, generation := answerViewFixture(t)
	request := ViewSidecarSendRequest{Source: "probe-surface", Generation: generation, Sidecar: service.name, Surface: "probe-surface",
		Body: json.RawMessage(`{"operation":"end","session":"s1"}`), Answer: true}
	if _, err := s.answerViewSidecar(context.Background(), request); err == nil || err.Error() != "sidecarSend answer requires cids" {
		t.Fatalf("answer without cids = %v", err)
	}
	if len(service.outbox) != 0 {
		t.Fatalf("a refused answer queued %d lines", len(service.outbox))
	}
}
