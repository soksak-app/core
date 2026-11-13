package deadline

import (
	"testing"
	"time"
)

func TestDeadline(t *testing.T) {
	deadline, ok := t.Deadline()
	if !ok {
		t.Fatal("the test has no deadline")
	}
	if left := time.Until(deadline); left > 7*time.Second || left < 5*time.Second {
		t.Fatalf("the deadline is %s away, not the limit of 7s", left)
	}
}
