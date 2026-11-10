package host_test

import (
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// nextNotice reads the next published notice.
func nextNotice(t *testing.T, notices <-chan host.LogNotice) host.LogNotice {
	t.Helper()
	notice := <-notices
	return notice
}

// contract: debug.follow.coalesces-writes-into-a-notice
//
// The check ends each interval itself: the publisher enters the spacing after a notice and stays in it until the check lets it out, so
// the announcements made while it is in the spacing are the ones that the bound on the rate folds into the next notice.
func TestLogNoticesAreBoundedInRateAndCountWhatTheyCoalesce(t *testing.T) {
	spaced := make(chan struct{}, 8)
	ends := make(chan struct{})
	published := make(chan host.LogNotice, 64)
	notices := host.NewLogNoticesSpacedBy(func() {
		spaced <- struct{}{}
		<-ends
	}, func(notice host.LogNotice) { published <- notice })
	defer notices.Stop()
	defer close(ends)
	if value := notices.Value(); value != (host.LogNotice{}) {
		t.Fatalf("the value before a notice is %+v", value)
	}
	notices.Observe("logs/host-b1.jsonl", 1)
	if first := nextNotice(t, published); first != (host.LogNotice{Path: "logs/host-b1.jsonl", Size: 1, Notices: 1}) {
		t.Fatalf("the first notice is %+v", first)
	}
	enterSpacing(t, spaced)
	// The publisher is in the spacing, so every announcement returns without waiting for it, and none is published before the interval
	// ends.
	for size := int64(2); size <= 50; size++ {
		notices.Observe("logs/host-b1.jsonl", size)
	}
	select {
	case early := <-published:
		t.Fatalf("the notice %+v was published before the interval ended", early)
	default:
	}
	ends <- struct{}{}
	last := nextNotice(t, published)
	if last != (host.LogNotice{Path: "logs/host-b1.jsonl", Size: 50, Notices: 2, Coalesced: 48}) {
		t.Fatalf("the notice after the interval is %+v, want the latest write with the 48 announcements before it coalesced", last)
	}
	enterSpacing(t, spaced)
	if value := notices.Value(); value != last {
		t.Fatalf("the value is %+v, the last notice %+v", value, last)
	}
	// No notice follows the latest write: after the interval, a new announcement is the next notice, and no announcement was folded
	// into it.
	ends <- struct{}{}
	notices.Observe("logs/host-b1.jsonl", 51)
	if next := nextNotice(t, published); next != (host.LogNotice{Path: "logs/host-b1.jsonl", Size: 51, Notices: 3, Coalesced: 48}) {
		t.Fatalf("the notice after the latest write is %+v, want only the new announcement", next)
	}
	enterSpacing(t, spaced)
}

// enterSpacing waits until the publisher entered the spacing after a notice.
func enterSpacing(t *testing.T, spaced <-chan struct{}) {
	t.Helper()
	<-spaced
}

// contract: debug.follow.announces-only-changes-that-are-not-log-reads
func TestAnUpdateOfTheIndexAnnouncesOnlyWhenALineAnnouncesAChange(t *testing.T) {
	published := make(chan host.LogNotice, 8)
	notices := host.NewLogNotices(time.Millisecond, func(notice host.LogNotice) { published <- notice })
	defer notices.Stop()
	notices.ObserveUpdate(sok.IndexUpdate{File: "logs/host-b1.jsonl", Changed: true, Lines: 3, Announcing: 0, Size: 300})
	// An announcement of the first update would be a notice before the one of the second update or would be counted as coalesced in it.
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
	// An announcement of the second query would be a notice before the one that follows or would be counted as coalesced in it.
	notices.Observe("logs/after.jsonl", 1)
	if next := nextNotice(t, published); next.Path != "logs/after.jsonl" || next.Notices != 2 || next.Coalesced != 0 {
		t.Fatalf("a query of a current index announced a change for %s: the next notice is %+v", path, next)
	}
}
