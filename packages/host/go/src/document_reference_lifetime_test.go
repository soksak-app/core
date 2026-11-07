//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDocumentReferenceAwaitKeepsLateErrorOwnershipAfterSchedulingFailure(t *testing.T) {
	isolateTraceRecords(t)
	s := &Surfaces{invoke: func(work func()) { work() }}
	var completion func(json.RawMessage, error)
	scheduled := errors.New("reference was not scheduled")
	_, err := awaitDocumentObservation(s, "document reference", func(done func(json.RawMessage, error)) error {
		completion = done
		return scheduled
	})
	if !errors.Is(err, scheduled) {
		t.Fatalf("await error = %v", err)
	}
	completion(nil, errors.New("late reference completion failed"))
	got := bufferedTraces(t, "host.record.error")
	if len(got) != 1 || got[0]["where"] != "document reference callback" || got[0]["text"] != "late reference completion failed" {
		t.Fatalf("late source errors = %#v", got)
	}
}

func TestDocumentReferenceAwaitRejectsDuplicateNativeCompletion(t *testing.T) {
	isolateTraceRecords(t)
	s := &Surfaces{invoke: func(work func()) { work() }}
	reply, err := awaitDocumentObservation(s, "document reference", func(done func(json.RawMessage, error)) error {
		done(json.RawMessage(`{"requestId":7}`), nil)
		done(nil, errors.New("second native result"))
		return nil
	})
	if err != nil || string(reply) != `{"requestId":7}` {
		t.Fatalf("result = %s, %v", reply, err)
	}
	got := bufferedTraces(t, "host.record.error")
	if len(got) != 1 || got[0]["where"] != "document reference callback" || !strings.Contains(got[0]["text"].(string), "completed more than once") {
		t.Fatalf("duplicate source errors = %#v", got)
	}
}

func TestDocumentReferenceAwaitSchedulesThroughItsHostDispatcher(t *testing.T) {
	inDispatcher := false
	s := &Surfaces{invoke: func(work func()) { inDispatcher = true; defer func() { inDispatcher = false }(); work() }}
	reply, err := awaitDocumentObservation(s, "document reference", func(done func(json.RawMessage, error)) error {
		if !inDispatcher {
			t.Fatal("native reference scheduling bypassed its host dispatcher")
		}
		done(json.RawMessage(`{"requestId":7}`), nil)
		return nil
	})
	if err != nil || string(reply) != `{"requestId":7}` {
		t.Fatalf("result = %s, %v", reply, err)
	}
	// This asserts host dispatch ownership. Actual native/Go thread identity belongs
	// to the maintained framework nativeworker owner, not this scheduler fixture.
}
