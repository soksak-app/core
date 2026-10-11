package host_test

import (
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// nextNotice reads the next published notice.
func nextNotice(t *testing.T, notices <-chan host.LogNotice) host.LogNotice {
	t.Helper()
	select {
	case notice := <-notices:
		return notice
	case <-time.After(5 * time.Second):
		t.Fatal("a notice did not arrive")
		return host.LogNotice{}
	}
}

// contract: debug.follow.coalesces-writes-into-a-notice
func TestLogNoticesAreBoundedInRateAndCountWhatTheyCoalesce(t *testing.T) {
	const interval = 150 * time.Millisecond
	release := make(chan struct{})
	published := make(chan host.LogNotice, 64)
	stamps := make(chan time.Time, 64)
	notices := host.NewLogNotices(interval, func(notice host.LogNotice) {
		<-release
		stamps <- time.Now()
		published <- notice
	})
	defer notices.Stop()
	if value := notices.Value(); value != (host.LogNotice{}) {
		t.Fatalf("the value before a notice is %+v", value)
	}
	started := time.Now()
	for size := int64(1); size <= 50; size++ {
		notices.Observe("logs/host-b1.jsonl", size)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("the writer waited %v for the notices", elapsed)
	}
	close(release)
	var last host.LogNotice
	var times []time.Time
	for last.Size != 50 {
		last = nextNotice(t, published)
		times = append(times, <-stamps)
	}
	if last.Path != "logs/host-b1.jsonl" || last.Notices+last.Coalesced != 50 || last.Notices != int64(len(times)) {
		t.Fatalf("the last notice is %+v after %d notices, want the latest write with 50 announcements counted as published or coalesced", last, len(times))
	}
	for i := 1; i < len(times); i++ {
		if gap := times[i].Sub(times[i-1]); gap < interval {
			t.Fatalf("notice %d came %v after the one before, under the bound of %v", i, gap, interval)
		}
	}
	if value := notices.Value(); value != last {
		t.Fatalf("the value is %+v, the last notice %+v", value, last)
	}
	select {
	case extra := <-published:
		t.Fatalf("a notice %+v follows the latest write", extra)
	case <-time.After(2 * interval):
	}
}

// contract: debug.follow.announces-only-changes-that-are-not-log-reads
func TestAnUpdateOfTheIndexAnnouncesOnlyWhenALineAnnouncesAChange(t *testing.T) {
	published := make(chan host.LogNotice, 8)
	notices := host.NewLogNotices(time.Millisecond, func(notice host.LogNotice) { published <- notice })
	defer notices.Stop()
	notices.ObserveUpdate(sok.IndexUpdate{File: "logs/host-b1.jsonl", Changed: true, Lines: 3, Announcing: 0, Size: 300})
	select {
	case notice := <-published:
		t.Fatalf("an update whose lines are all log reads announced %+v", notice)
	case <-time.After(300 * time.Millisecond):
	}
	notices.ObserveUpdate(sok.IndexUpdate{File: "logs/host-b1.jsonl", Changed: true, Lines: 3, Announcing: 1, Size: 400})
	if notice := nextNotice(t, published); notice.Path != "logs/host-b1.jsonl" || notice.Size != 400 || notice.Notices != 1 || notice.Coalesced != 0 {
		t.Fatalf("the notice of an update with an announcing line is %+v", notice)
	}
}

// contract: debug.follow.query-announces-the-lines-it-indexes
func TestAQueryThatIndexesLinesAnnouncesThemOnce(t *testing.T) {
	published := make(chan host.LogNotice, 8)
	notices := host.NewLogNotices(time.Millisecond, func(notice host.LogNotice) { published <- notice })
	defer notices.Stop()
	host.UseLogNotices(notices)
	defer host.UseLogNotices(nil)
	config := t.TempDir()
	path := writeEventFile(t, config, "host-b1.jsonl", eventLines(5))
	if _, invalid, err := host.QueryEventLogs(config, []byte(`{"channel":"all"}`)); invalid || err != nil {
		t.Fatalf("the query: invalid %v err %v", invalid, err)
	}
	notice := nextNotice(t, published)
	if notice.Path != "logs/host-b1.jsonl" || notice.Size == 0 {
		t.Fatalf("the query that built the index announced %+v", notice)
	}
	// The same query again finds the index current and announces nothing.
	if _, _, err := host.QueryEventLogs(config, []byte(`{"channel":"all"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case extra := <-published:
		t.Fatalf("a query of a current index announced %+v for %s", extra, path)
	case <-time.After(300 * time.Millisecond):
	}
}
