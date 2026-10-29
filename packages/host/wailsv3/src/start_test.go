package host

import (
	"encoding/json"
	"errors"
	"testing"
	"unsafe"
)

// contract: images.reload.start-sends-detach-without-waiting
func TestStartPageSendsTheReloadedImageDetachAndLeavesItsSurfacePending(t *testing.T) {
	c := sidecarSessionSurfaces(t).sidecars
	c.stopped = false
	service := &sidecar{name: "fixture-sidecar", persistent: true, outbox: make(chan queuedLine, 4),
		closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{}}
	c.running["fixture-sidecar"] = service
	surfaces := NewSurfaces(nil, c)
	surfaces.invoke = func(task func()) { task() }
	surfaces.reloadCancelLayout = func() error { return nil }
	surfaces.reloadHideSurface = func(unsafe.Pointer, bool) {}
	surfaces.reloadCloseImage = func(unsafe.Pointer) {}
	surfaces.events = func(string, any) {}
	surfaces.views["surface-a"] = &nativeWebview{}
	key := ImageKey{Surface: "surface-a", Name: "view"}
	if err := surfaces.images.Reserve(key, &ImageOwner{SidecarName: "fixture-sidecar", SidecarOwner: surfaces}); err != nil {
		t.Fatalf("reserve image: %v", err)
	}
	if !surfaces.images.Set(key, unsafe.Pointer(new(byte))) {
		t.Fatal("set image handle failed")
	}
	owner := &Host{windows: map[uint]*Surfaces{1: surfaces}, workspace: NewWorkspace(t.TempDir()),
		relay: &Relay[relayTarget]{waiting: map[uint64]*relayWaiter[relayTarget]{}}}
	surfaces.host = owner
	if _, err := owner.startPage(1); !errors.Is(err, errNoWindow) {
		t.Fatalf("page start with an unacknowledged image detach: %v, want the later no-window test boundary", err)
	}
	var sent sidecarRequest
	select {
	case line := <-service.outbox:
		if err := json.Unmarshal(line.bytes, &sent); err != nil {
			t.Fatalf("decode image detach request: %v", err)
		}
	default:
		t.Fatal("page start did not send the image detach request")
	}
	var body struct {
		Image struct {
			Detach imageDetachAck `json:"detach"`
		} `json:"image"`
	}
	if err := json.Unmarshal(sent.Body, &body); err != nil {
		t.Fatalf("decode image detach body: %v", err)
	}
	if sent.Surface != key.Surface || body.Image.Detach.Name != key.Name || body.Image.Detach.Generation == 0 || body.Image.Detach.Request == "" {
		t.Fatalf("image detach request %q/%s, want the old image identity", sent.Surface, sent.Body)
	}
	if err := surfaces.pendingImageDetachError(key.Surface); err == nil {
		t.Fatal("page start left no pending detach for the surface of the reloaded image")
	}
}
