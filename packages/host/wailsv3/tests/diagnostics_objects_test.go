//go:build diagnostics

package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: diagnostics.objects.counts-host-objects
func TestDocumentRegionCountFallsBackWhenRemoved(t *testing.T) {
	docs := host.NewDocuments()
	one := host.DocumentKey{Surface: "tab-1", Name: "page"}
	two := host.DocumentKey{Surface: "tab-1", Name: "side"}
	if got := docs.Count(); got != 0 {
		t.Fatalf("empty registry counts %d document regions, want 0", got)
	}
	for _, key := range []host.DocumentKey{one, two} {
		if err := docs.Reserve(key); err != nil {
			t.Fatal(err)
		}
	}
	if got := docs.Count(); got != 2 {
		t.Fatalf("two reserved names count %d document regions, want 2", got)
	}
	if _, err := docs.Remove(one); err != nil {
		t.Fatal(err)
	}
	if got := docs.Count(); got != 1 {
		t.Fatalf("after one removal the count is %d, want 1", got)
	}
	docs.RemoveSurface("tab-1")
	if got := docs.Count(); got != 0 {
		t.Fatalf("after the surface closed the count is %d, want 0", got)
	}
}

// contract: diagnostics.objects.counts-host-objects
func TestImageRegionCountFallsBackWhenRemoved(t *testing.T) {
	images := host.NewImages()
	owner := &host.ImageOwner{SidecarName: "image", SidecarOwner: newFakeOwner("/root")}
	one := host.ImageKey{Surface: "tab-1", Name: "picture"}
	two := host.ImageKey{Surface: "tab-1", Name: "thumb"}
	if got := images.Count(); got != 0 {
		t.Fatalf("empty registry counts %d image regions, want 0", got)
	}
	for _, key := range []host.ImageKey{one, two} {
		if err := images.Reserve(key, owner); err != nil {
			t.Fatal(err)
		}
	}
	if got := images.Count(); got != 2 {
		t.Fatalf("two reserved names count %d image regions, want 2", got)
	}
	if _, err := images.Remove(one); err != nil {
		t.Fatal(err)
	}
	if got := images.Count(); got != 1 {
		t.Fatalf("after one removal the count is %d, want 1", got)
	}
	images.RemoveSurface("tab-1")
	if got := images.Count(); got != 0 {
		t.Fatalf("after the surface closed the count is %d, want 0", got)
	}
}

// contract: diagnostics.objects.counts-host-objects
func TestSidecarSessionAndPendingReplyCountsFollowTheOwner(t *testing.T) {
	directory := t.TempDir()
	// The fixture keeps its standard input open, so the session stays running until the surface is closed.
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte("#!/bin/sh\ncat > /dev/null\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"echo","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	sidecars.StopTimeout = stall
	t.Cleanup(sidecars.Stop)
	owner := newFakeOwner(directory)
	other := newFakeOwner(directory)
	if got := sidecars.SessionCount(owner); got != 0 {
		t.Fatalf("no session counts %d for the owner, want 0", got)
	}
	if err := sidecars.SendWithCids(owner, echoSidecar, "s1", json.RawMessage(`{}`), []string{"c1"}); err != nil {
		t.Fatal(err)
	}
	if got := sidecars.SessionCount(owner); got != 1 {
		t.Fatalf("one surface of the owner counts %d sessions, want 1", got)
	}
	if got := sidecars.SessionCount(other); got != 0 {
		t.Fatalf("another owner counts %d sessions, want 0", got)
	}
	if got := sidecars.PendingCount(owner); got != 1 {
		t.Fatalf("one request without a reply counts %d pending replies, want 1", got)
	}
	if got := sidecars.PendingCount(other); got != 0 {
		t.Fatalf("another owner counts %d pending replies, want 0", got)
	}
	sidecars.Close("s1")
	if got := sidecars.SessionCount(owner); got != 0 {
		t.Fatalf("after the surface closed the owner counts %d sessions, want 0", got)
	}
}

// contract: diagnostics.objects.counts-host-objects
func TestEventSubscriberCountFollowsTheSubscription(t *testing.T) {
	backend := newFakeBackend()
	endpoint, address, _ := serve(t, backend)
	if got := endpoint.SubscriberCount("main"); got != 0 {
		t.Fatalf("no subscriber counts %d for main, want 0", got)
	}
	conn := dial(t, address)
	params := json.RawMessage(`{"window":"main","name":"core.layout"}`)
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "status.watch", "params": params})
	// The page receives the first subscription after the count changed, so its request marks the count as changed.
	<-backend.watched
	if got := endpoint.SubscriberCount("main"); got != 1 {
		t.Fatalf("one subscribed connection counts %d for main, want 1", got)
	}
	if got := endpoint.SubscriberCount("other"); got != 0 {
		t.Fatalf("subscription of main counts %d for another window, want 0", got)
	}
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "status.unwatch", "params": params})
	<-backend.unwatched
	if got := endpoint.SubscriberCount("main"); got != 0 {
		t.Fatalf("after the last release the count is %d for main, want 0", got)
	}
}

// contract: diagnostics.objects.counts-host-objects
func TestRelayPendingCountFollowsTheWaitingRequests(t *testing.T) {
	relay := host.NewRelay[string]()
	if got := relay.Pending(func(target string) bool { return target == "main" }); got != 0 {
		t.Fatalf("empty relay counts %d waiting requests, want 0", got)
	}
	done := make(chan host.ExposureResult, 1)
	sent := make(chan struct{})
	go func() {
		done <- relay.Request("main", 10*time.Second, func(uint64) error { close(sent); return nil })
	}()
	// The request is registered before it is sent, so the send marks the count as changed.
	<-sent
	if got := relay.Pending(func(target string) bool { return target == "main" }); got != 1 {
		t.Fatalf("one waiting request counts %d for main, want 1", got)
	}
	if got := relay.Pending(func(target string) bool { return target == "other" }); got != 0 {
		t.Fatalf("another target counts %d waiting requests, want 0", got)
	}
	relay.Abandon(func(target string) bool { return target == "main" })
	<-done
	if got := relay.Pending(func(target string) bool { return target == "main" }); got != 0 {
		t.Fatalf("after the request ended the relay counts %d waiting requests, want 0", got)
	}
}

// contract: diagnostics.objects.counts-host-objects
func TestHostObjectsPayloadNamesEveryCount(t *testing.T) {
	counts := host.HostObjects{Surfaces: 1, Regions: 2, Documents: 3, SidecarSessions: 4, PendingReplies: 5, EventSubscribers: 6}
	want := map[string]int64{"surfaces": 1, "regions": 2, "documents": 3, "sidecarSessions": 4, "pendingReplies": 5, "eventSubscribers": 6}
	if got := counts.Payload(); !reflect.DeepEqual(got, want) {
		t.Fatalf("payload = %#v, want %#v", got, want)
	}
}

// contract: diagnostics.objects.counts-documents
func TestPageObjectsPayloadNamesElementsAndDocuments(t *testing.T) {
	counts := host.PageObjects{Elements: 7, Documents: 2}
	want := map[string]int64{"elements": 7, "documents": 2}
	if got := counts.Payload(); !reflect.DeepEqual(got, want) {
		t.Fatalf("payload = %#v, want %#v", got, want)
	}
}
