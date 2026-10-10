package host_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// contract: project-removal.abandon.records-each-allowed-removal
func TestTheEndOfAWindowRecordsEachRemovalItAllows(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	var removals host.Removals
	for id, owner := range map[string]string{"prj-a": "project-one", "prj-b": "project-one", "prj-c": "project-two"} {
		if _, err := removals.Begin(id, owner); err != nil {
			t.Fatal(err)
		}
	}
	removals.Abandon("project-one")
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var allowed []string
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] != "host.project.removal_allowed" {
			continue
		}
		fields := event["fields"].(map[string]any)
		if fields["window"] != "project-one" {
			t.Fatalf("host.project.removal_allowed fields = %v, want the window project-one", fields)
		}
		allowed = append(allowed, fields["project"].(string))
	}
	slices.Sort(allowed)
	if !slices.Equal(allowed, []string{"prj-a", "prj-b"}) {
		t.Fatalf("host.project.removal_allowed projects = %v, want [prj-a prj-b]", allowed)
	}
}

// contract: project-removal.ask.waits-for-the-owner-answer
func TestAProjectRemovalRequestResolvesWithTheOwnerAnswer(t *testing.T) {
	var removals host.Removals
	asked, err := removals.Begin("prj-one", "project-one")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := removals.Begin("prj-one", "project-one"); err == nil || !strings.Contains(err.Error(), "prj-one") {
		t.Fatalf("a second request for the same project returned %v", err)
	}
	if err := removals.Answer("prj-one", false); err != nil {
		t.Fatal(err)
	}
	if allowed := <-asked; allowed {
		t.Fatal("a kept tab answered that the removal is allowed")
	}
	if err := removals.Answer("prj-one", true); err == nil {
		t.Fatal("an answer without a request was accepted")
	}
	for _, id := range []string{"", "Bad Id"} {
		if _, err := removals.Begin(id, "project-one"); err == nil {
			t.Fatalf("project id %q was accepted", id)
		}
	}
	// A window that ends while it is asked answers that the removal is allowed.
	asked, err = removals.Begin("prj-two", "project-two")
	if err != nil {
		t.Fatal(err)
	}
	removals.Abandon("project-other")
	select {
	case <-asked:
		t.Fatal("the end of another window answered the request")
	default:
	}
	removals.Abandon("project-two")
	if allowed := <-asked; !allowed {
		t.Fatal("the end of the asked window did not allow the removal")
	}
}
