package main_test

import (
	"testing"

	"github.com/min-median-max/soksak/sidecars/ptyd/src/ptyd"
)

// TestAttachWithTruncation는 링을 넘긴 경우 truncated를 보고하는지 확인한다.
func TestAttachWithTruncation(t *testing.T) {
	session := ptyd.NewSession("test-session", 5)

	// 링에 충분히 채우기 위해 readPump를 시뮬레이션
	// readPump가 없으므로 직접 링에 항목을 추가하는 대신 Resize를 사용하여 nextSeq를 증가시킴
	for i := 0; i < 6; i++ {
		_ = session.Resize(80, 24)
	}

	consumer := &ptyd.Consumer{SessionID: "test-session"}
	truncated, err := session.Attach(consumer, 0)

	// 링이 5개 항목이고 6개를 추가했으므로 처음 항목이 버려졌어야 함
	if err != nil {
		t.Fatalf("attach failed: %v", err)
	}

	if !truncated {
		t.Error("expected truncated=true")
	}

	session.Detach(consumer)
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
