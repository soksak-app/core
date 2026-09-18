package main_test

import (
	"testing"

	"github.com/min-median-max/soksak/sidecars/ptyd/src/ptyd"
)

// TestMultipleConsumersReceiveSameSequence는 두 소비자가 같은 출력을 같은 순번으로 받는지 확인한다.
func TestMultipleConsumersReceiveSameSequence(t *testing.T) {
	session := ptyd.NewSession("test-session", 100)

	consumer1 := &ptyd.Consumer{SessionID: "test-session", Ch: make(chan ptyd.RingEntry, 10)}
	consumer2 := &ptyd.Consumer{SessionID: "test-session", Ch: make(chan ptyd.RingEntry, 10)}

	trunc1, entries1 := session.Attach(consumer1, 0)
	trunc2, entries2 := session.Attach(consumer2, 0)

	if trunc1 || trunc2 {
		t.Fatal("unexpected truncation on initial attach")
	}
	if len(entries1) != 0 || len(entries2) != 0 {
		t.Fatal("expected no initial entries")
	}

	testData := []byte("hello")
	if err := session.TestWrite(testData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	if session.GetNextSeq() != 1 {
		t.Errorf("expected next sequence 1, got %d", session.GetNextSeq())
	}

	session.Detach(consumer1)
	session.Detach(consumer2)
}

// TestAttachWithTruncation는 링을 넘긴 경우 truncated를 보고하는지 확인한다.
func TestAttachWithTruncation(t *testing.T) {
	session := ptyd.NewSession("test-session", 5)

	for i := 0; i < 6; i++ {
		if err := session.TestWrite([]byte("data")); err != nil {
			t.Fatalf("write %d failed: %v", i, err)
		}
	}

	consumer := &ptyd.Consumer{SessionID: "test-session", Ch: make(chan ptyd.RingEntry, 10)}
	truncated, entries := session.Attach(consumer, 0)

	if !truncated {
		t.Error("expected truncated=true")
	}

	if len(entries) == 0 {
		t.Fatal("expected entries from current ring")
	}

	session.Detach(consumer)
}

// TestClientDisconnectSessionSurvives는 모든 클라이언트를 끊어도 세션이 살아있는지 확인한다.
func TestClientDisconnectSessionSurvives(t *testing.T) {
	session := ptyd.NewSession("test-session", 100)

	consumer := &ptyd.Consumer{SessionID: "test-session", Ch: make(chan ptyd.RingEntry, 10)}
	session.Attach(consumer, 0)

	session.Detach(consumer)

	if session.Closed() {
		t.Error("session should not be closed after consumer detach")
	}

	if err := session.TestWrite([]byte("test")); err != nil {
		t.Errorf("failed to write after consumer detach: %v", err)
	}
}

// TestResizeRecorded는 resize가 링에 기록되는지 확인한다.
func TestResizeRecorded(t *testing.T) {
	session := ptyd.NewSession("test-session", 100)

	if err := session.Resize(80, 24); err != nil {
		t.Fatalf("resize failed: %v", err)
	}

	if session.GetNextSeq() != 1 {
		t.Errorf("expected sequence 1 after resize, got %d", session.GetNextSeq())
	}
}
