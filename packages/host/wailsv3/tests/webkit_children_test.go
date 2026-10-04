package host_test

import (
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: webkit-children.reap.requires-alive-webkit-same-start
func TestAReapDecisionKillsOnlyTheProvenOrphan(t *testing.T) {
	if reason := host.ReapDecision(true, true, true); reason != "" {
		t.Fatalf("reap decision = %q, want kill", reason)
	}
}

// contract: webkit-children.reap.requires-alive-webkit-same-start
func TestADeadChildHasNothingToReap(t *testing.T) {
	if reason := host.ReapDecision(false, true, true); reason != "already dead; nothing to reap" {
		t.Fatalf("reap decision = %q", reason)
	}
}

// contract: webkit-children.reap.requires-alive-webkit-same-start
func TestARecycledPidIsNeverKilled(t *testing.T) {
	if reason := host.ReapDecision(true, false, true); reason != "no longer a WebKit process (recycled?); not killing" {
		t.Fatalf("reap decision = %q", reason)
	}
}

// contract: webkit-children.reap.requires-alive-webkit-same-start
func TestASamePidDifferentInstanceIsNeverKilled(t *testing.T) {
	if reason := host.ReapDecision(true, true, false); reason != "start time differs from the record; not killing" {
		t.Fatalf("reap decision = %q", reason)
	}
}
