package host

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
	"unsafe"
)

type imageStatusTestOwner struct{}

func (imageStatusTestOwner) ProjectRoot() string { return "" }
func (imageStatusTestOwner) Emit(string, ...any) {}

// contract: exposure.window.region-reports-presented-frame
func TestPresentedFrameChangeNotifiesAfterItsIdentityIsCurrent(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "tab-1", Name: "view"}
	var handle int
	if err := images.Reserve(key, &ImageOwner{SidecarName: "sidecar-a", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	if !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatal("image was not attached")
	}
	raster, err := images.ConfigureRaster(key, 800, 600, 2, true)
	if err != nil || raster == nil {
		t.Fatalf("configure image: %+v, %v", raster, err)
	}
	body, err := json.Marshal(map[string]any{"image": map[string]any{
		"name":  "view",
		"token": map[string]any{"kind": "iosurface-global", "id": uint32(12345), "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="},
		"width": 800, "height": 600, "scale": 2.0, "format": "bgra8",
		"generation": raster.Generation, "raster": raster.Raster, "sequence": 2,
	}})
	if err != nil {
		t.Fatal(err)
	}
	var notified *PresentedFrame
	HandleEnvelope(body, "sidecar-a", key.Surface, images,
		func(func() error) error { return nil },
		func(string, map[string]interface{}) error { return nil },
		func(string) error { return nil },
		func() bool { return true },
		func() {
			if frame, ok := images.PresentedFrame(key); ok {
				notified = &frame
			}
		},
	)
	if notified == nil || notified.Generation != raster.Generation || notified.Raster != raster.Raster || notified.Sequence != 2 {
		t.Fatalf("window notification observed frame %+v, want generation %d raster %d sequence 2",
			notified, raster.Generation, raster.Raster)
	}
}

// contract: exposure.window.region-reports-presented-frame
func TestFailedOrRetiredFrameDoesNotNotifyItsWindowWatcher(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "tab-1", Name: "view"}
	var handle int
	if err := images.Reserve(key, &ImageOwner{SidecarName: "sidecar-a", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	if !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatal("image was not attached")
	}
	raster, err := images.ConfigureRaster(key, 800, 600, 2, true)
	if err != nil || raster == nil {
		t.Fatalf("configure image: %+v, %v", raster, err)
	}
	body := func(sequence int) []byte {
		value, err := json.Marshal(map[string]any{"image": map[string]any{
			"name":  "view",
			"token": map[string]any{"kind": "iosurface-global", "id": uint32(12345), "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="},
			"width": 800, "height": 600, "scale": 2.0, "format": "bgra8",
			"generation": raster.Generation, "raster": raster.Raster, "sequence": sequence,
		}})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	send := func(string, map[string]interface{}) error { return nil }
	recoverFrame := func(string) error { return nil }
	if !HandleEnvelope(body(1), "sidecar-a", key.Surface, images,
		func(func() error) error { return errors.New("presentFailed") }, send, recoverFrame,
		func() bool { return true }, func() { t.Fatal("failed presentation notified the window") }) {
		t.Fatal("failed frame was not handled")
	}
	if _, ok := images.PresentedFrame(key); ok {
		t.Fatal("failed frame became presented")
	}
	if !HandleEnvelope(body(2), "sidecar-a", key.Surface, images,
		func(func() error) error {
			images.BeginGeneration(key.Surface)
			return nil
		}, send, recoverFrame,
		func() bool { return true }, func() { t.Fatal("retired frame notified the window") }) {
		t.Fatal("retired frame was not handled")
	}
	if _, ok := images.PresentedFrame(key); ok {
		t.Fatal("retired frame became presented")
	}
}

func TestPendingNewerFrameIsRequiredAfterTheWaitBegins(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "surface", Name: "view"}
	var handle int
	if err := images.Reserve(key, &ImageOwner{SidecarName: "sidecar", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	if !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatal("image was not attached")
	}
	config, err := images.ConfigureRaster(key, 800, 600, 2, true)
	if err != nil || config == nil {
		t.Fatalf("configure raster: %+v, %v", config, err)
	}
	images.mu.Lock()
	images.states[key].LastSequence = 1
	images.mu.Unlock()
	began := time.Now()
	timeout := 500 * time.Millisecond
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- images.waitCurrentObserved(timeout, func() { close(started) }) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("image wait did not begin")
	}
	// Hold the owner lock across presentation and the next arrival so the waiter wakes after both.
	images.mu.Lock()
	state := images.states[key]
	state.PresentedRaster = config.Raster
	state.PresentedSequence = 1
	state.LastSequence = 2
	images.changedLocked()
	elapsed := time.Since(began)
	images.mu.Unlock()
	var outcome error
	select {
	case outcome = <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("image wait did not end")
	}
	if elapsed >= timeout {
		t.Fatalf("controlled arrival missed the active wait deadline: %v", elapsed)
	}
	if outcome == nil || outcome.Error() != "presentationTimeout" {
		t.Fatalf("pending newer frame did not remain required: %v", outcome)
	}
	if images.CurrentPresented() {
		t.Fatal("instantaneous status omitted the pending newer frame")
	}
	if images.WaitCurrent(0) {
		t.Fatal("new wait omitted the already accepted second frame")
	}
}
