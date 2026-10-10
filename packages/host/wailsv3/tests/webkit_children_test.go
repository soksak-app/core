package host_test

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// psErrors returns the texts of the error records of the place `webkit children` that the host stored after it reaped the
// record of an earlier run whose host and child no longer exist.
func psErrors(t *testing.T, path string) []string {
	t.Helper()
	config := t.TempDir()
	log := support.StartWriter(t, config)
	record := `{"host_pid": 2147483000, "children": [{"pid": 2147483001, "kind": "WebContent", "lstart": "x"}]}`
	if err := os.WriteFile(filepath.Join(config, "webkit-children.json"), []byte(record), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", path)
	host.ReapRecordedWebKit(config)
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		fields, _ := event["fields"].(map[string]any)
		if event["event"] == "host.record.error" && fields["where"] == "webkit children" {
			texts = append(texts, fields["text"].(string))
		}
	}
	return texts
}

// contract: webkit-children.ps.reports-a-failed-query
func TestAFailedPsQueryIsReportedAndAMissingProcessIsNot(t *testing.T) {
	if texts := psErrors(t, os.Getenv("PATH")); len(texts) != 0 {
		t.Fatalf("ps answered that no process exists, and the host reported %q", texts)
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "ps"), []byte("#!/bin/sh\necho 'ps: boom' >&2\nexit 2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	texts := psErrors(t, bin)
	if len(texts) != 4 {
		t.Fatalf("a failing ps gave the error records %q, want one for each of the four queries of the reap", texts)
	}
	for _, text := range texts {
		if !strings.Contains(text, "boom") || !strings.Contains(text, "ps ") {
			t.Fatalf("the error record %q names neither the query nor the message of ps", text)
		}
	}
}

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

// contract: webkit-children.record.concurrent-refreshes
// 여러 창의 페이지 적재가 동시에 기록을 갱신해도 모든 갱신이 성공하고 기록은 마지막으로 쓴 내용이다(F68).
func TestConcurrentWebKitRecordWritesAllSucceed(t *testing.T) {
	target := filepath.Join(t.TempDir(), "webkit-children.json")
	const writers = 32
	failures := make(chan error, writers)
	var wait sync.WaitGroup
	for index := 0; index < writers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			if err := host.WriteWebKitRecord(target, []byte(fmt.Sprintf(`{"writer":%d}`, index))); err != nil {
				failures <- err
			}
		}(index)
	}
	wait.Wait()
	close(failures)
	for err := range failures {
		t.Errorf("a concurrent record write failed: %v", err)
	}
	if _, err := os.Stat(target + ".new"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a temporary record file was left behind: %v", err)
	}
}
