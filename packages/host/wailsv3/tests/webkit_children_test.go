package host_test

import (
	"os"
	"path/filepath"
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

// 기록이 없으면 갱신은 이 실행의 WebKit 자식 기록을 새로 쓰고, 그 파일은 현재 사용자만 읽고 쓴다.
// contract: webkit-children.record.owner-only
func TestTheWebKitChildRecordIsOwnerOnly(t *testing.T) {
	config := t.TempDir()
	host.SnapshotBaseline()
	host.RefreshWebKitChildren(config)
	info, err := os.Stat(filepath.Join(config, "webkit-children.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("record has mode %o, want 600", info.Mode().Perm())
	}
}
