package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

type imageStatusTestOwner struct{}

func (imageStatusTestOwner) ProjectRoot() string                  { return "" }
func (imageStatusTestOwner) Emit(string, ...any)                  {}
func (imageStatusTestOwner) DeliverSidecarMessage(SidecarMessage) {}

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

// contract: exposure.window.region-reports-presented-frame, images.wait.newer-sequence-rearms-wait
func TestInFlightFramePresentationIsRecordedAfterANewerFrameIsAccepted(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "surface-in-flight", Name: "view"}
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
	if reason := images.AuthorizeFrame(key, "sidecar", config.Generation, config.Raster, 800, 600, 2, 1); reason != "" {
		t.Fatalf("authorize first frame: %s", reason)
	}
	if status := images.FrameStatus(key, config.Generation, config.Raster, 1); status != "" {
		t.Fatalf("first frame failed the pre-presentation freshness check: %s", status)
	}
	if reason := images.AuthorizeFrame(key, "sidecar", config.Generation, config.Raster, 800, 600, 2, 2); reason != "" {
		t.Fatalf("authorize newer frame while the first native presentation is in flight: %s", reason)
	}
	if status := images.FrameStatus(key, config.Generation, config.Raster, 1); status != "stale" {
		t.Fatalf("an older frame passed a new pre-presentation freshness check: %q", status)
	}
	if status := images.FrameStatus(key, config.Generation, config.Raster, 2); status != "" {
		t.Fatalf("newest frame failed the pre-presentation freshness check: %s", status)
	}

	for _, tc := range []struct {
		name       string
		generation uint64
		raster     uint64
		sequence   int
	}{
		{name: "zero sequence", generation: config.Generation, raster: config.Raster, sequence: 0},
		{name: "future sequence", generation: config.Generation, raster: config.Raster, sequence: 3},
		{name: "wrong generation", generation: config.Generation + 1, raster: config.Raster, sequence: 1},
		{name: "wrong raster", generation: config.Generation, raster: config.Raster + 1, sequence: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if images.MarkPresented(key, tc.generation, tc.raster, tc.sequence) {
				t.Fatal("invalid presentation acknowledgment changed image state")
			}
		})
	}
	if _, ok := images.PresentedFrame(key); ok {
		t.Fatal("invalid acknowledgment produced a presented frame")
	}
	if !images.MarkPresented(key, config.Generation, config.Raster, 1) {
		t.Fatal("successful in-flight frame acknowledgment was discarded after a newer acceptance")
	}
	if images.CurrentPresented() {
		t.Fatal("the latest-frame barrier completed before sequence 2 was acknowledged")
	}
	if !images.MarkPresented(key, config.Generation, config.Raster, 2) {
		t.Fatal("newest frame acknowledgment was not recorded")
	}
	frame, ok := images.PresentedFrame(key)
	if !ok || frame.Generation != config.Generation || frame.Raster != config.Raster || frame.Sequence != 2 {
		t.Fatalf("presented frame is %+v, want generation %d raster %d sequence 2", frame, config.Generation, config.Raster)
	}
	for _, sequence := range []int{2, 1} {
		if images.MarkPresented(key, config.Generation, config.Raster, sequence) {
			t.Fatalf("duplicate or regressing acknowledgment for sequence %d changed image state", sequence)
		}
	}
	if !images.CurrentPresented() {
		t.Fatal("the latest accepted frame is not reported presented after its acknowledgment")
	}
}

// contract: images.present.older-ack-preserves-newer-rejection
func TestOlderInFlightPresentationDoesNotClearANewerFrameFailure(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "surface-in-flight-failure", Name: "view"}
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
	for sequence := 1; sequence <= 2; sequence++ {
		if reason := images.AuthorizeFrame(key, "sidecar", config.Generation, config.Raster, 800, 600, 2, sequence); reason != "" {
			t.Fatalf("authorize sequence %d: %s", sequence, reason)
		}
	}
	images.MarkPresentationFailed(key, config.Generation, config.Raster, 2, "sequence 2 failed")
	if !images.MarkPresented(key, config.Generation, config.Raster, 1) {
		t.Fatal("successful in-flight sequence 1 acknowledgment was discarded")
	}
	frame, ok := images.PresentedFrame(key)
	if !ok || frame.Sequence != 1 {
		t.Fatalf("presented frame is %+v, want sequence 1", frame)
	}
	images.mu.Lock()
	state := images.states[key]
	configured, presentationError := state.Configured, state.PresentationError
	images.mu.Unlock()
	if configured || presentationError != "sequence 2 failed" {
		t.Fatalf("newer failure state is configured=%t error=%q", configured, presentationError)
	}
}

// errRasterPending is the decision of layoutWait on a raster wait that found a raster pending.
var errRasterPending = errors.New("a raster is pending")

// layoutWait decides the layout raster wait on the current images without time: the wait answers at once when its rasters are
// complete or failed, and a wait that reports a pending check is ended by the end of the layout transaction, as a press or a
// cancel ends it, and decides errRasterPending.
func layoutWait(t *testing.T, images *Images, settled bool) error {
	t.Helper()
	type step struct {
		pending bool
		err     error
	}
	steps := make(chan step, 8)
	go func() {
		err := images.waitLayoutRastersObserved(settled, func() { steps <- step{pending: true} })
		steps <- step{err: err}
	}()
	first := <-steps
	if !first.pending {
		return first.err
	}
	images.EndWaits()
	for next := range steps {
		if next.pending {
			continue
		}
		if !errors.Is(next.err, errLayoutWaitEnded) {
			t.Fatalf("the pending raster wait ended with %v, want the end of its layout", next.err)
		}
		break
	}
	return errRasterPending
}

// contract: images.wait.continuous-raster-snapshot, images.wait.newer-sequence-rearms-wait
func TestContinuousImageWaitUsesInstalledSnapshotAndBlocksAfterGenerationOrRasterChange(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "surface-continuous-snapshot", Name: "view"}
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
	for sequence := 1; sequence <= 2; sequence++ {
		if reason := images.AuthorizeFrame(key, "sidecar", config.Generation, config.Raster, 800, 600, 2, sequence); reason != "" {
			t.Fatalf("authorize sequence %d: %s", sequence, reason)
		}
		if sequence == 1 && !images.MarkPresented(key, config.Generation, config.Raster, sequence) {
			t.Fatal("initial raster snapshot was not recorded")
		}
	}
	if err := layoutWait(t, images, false); err != nil {
		t.Fatalf("continuous wait rejected the installed raster snapshot after a newer same-raster sequence was accepted: %v", err)
	}
	if err := layoutWait(t, images, true); !errors.Is(err, errRasterPending) {
		t.Fatalf("settled wait returned %v, want a pending raster while the newest sequence is pending", err)
	}
	frame, ok := images.PresentedFrame(key)
	if !ok || frame.Generation != config.Generation || frame.Raster != config.Raster || frame.Sequence != 1 {
		t.Fatalf("presented frame is %+v, want the installed sequence 1 snapshot", frame)
	}

	oldGeneration := config.Generation
	newGeneration := images.BeginGeneration(key.Surface)
	if _, ok := images.PresentedFrame(key); ok {
		t.Fatal("the previous generation remained the installed presented snapshot")
	}
	newConfig, err := images.ConfigureRaster(key, 800, 600, 2, true)
	if err != nil || newConfig == nil || newConfig.Generation != newGeneration || newConfig.Raster != config.Raster {
		t.Fatalf("configure same raster in new generation: %+v, %v", newConfig, err)
	}
	if reason := images.AuthorizeFrame(key, "sidecar", newGeneration, newConfig.Raster, 800, 600, 2, 1); reason != "" {
		t.Fatalf("authorize new-generation sequence 1: %s", reason)
	}
	if images.MarkPresented(key, oldGeneration, config.Raster, 1) {
		t.Fatal("the previous-generation acknowledgment was accepted")
	}
	if err := layoutWait(t, images, false); !errors.Is(err, errRasterPending) {
		t.Fatalf("unpresented new-generation sequence returned %v, want a pending raster", err)
	}
	if !images.MarkPresented(key, newGeneration, newConfig.Raster, 1) {
		t.Fatal("new-generation raster snapshot was not recorded")
	}
	if err := layoutWait(t, images, false); err != nil {
		t.Fatalf("new-generation raster snapshot did not complete the continuous wait: %v", err)
	}

	rasterConfig, err := images.ConfigureRaster(key, 801, 600, 2, true)
	if err != nil || rasterConfig == nil || rasterConfig.Raster == newConfig.Raster {
		t.Fatalf("configure changed raster: %+v, %v", rasterConfig, err)
	}
	if err := layoutWait(t, images, false); !errors.Is(err, errRasterPending) {
		t.Fatalf("unpresented changed raster returned %v, want a pending raster", err)
	}
	if reason := images.AuthorizeFrame(key, "sidecar", rasterConfig.Generation, rasterConfig.Raster, 801, 600, 2, 1); reason != "" {
		t.Fatalf("authorize changed-raster sequence 1: %s", reason)
	}
	if err := layoutWait(t, images, false); !errors.Is(err, errRasterPending) {
		t.Fatalf("accepted but unpresented changed raster returned %v, want a pending raster", err)
	}
	if !images.MarkPresented(key, rasterConfig.Generation, rasterConfig.Raster, 1) {
		t.Fatal("changed-raster snapshot was not recorded")
	}
	if err := layoutWait(t, images, false); err != nil {
		t.Fatalf("changed-raster snapshot did not complete the continuous wait: %v", err)
	}
}

// contract: images.wait.continuous-raster-snapshot
func TestBeginningNewGenerationClearsThePresentedImageSnapshot(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "surface-generation-snapshot", Name: "view"}
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
	if reason := images.AuthorizeFrame(key, "sidecar", config.Generation, config.Raster, 800, 600, 2, 1); reason != "" {
		t.Fatalf("authorize frame: %s", reason)
	}
	if !images.MarkPresented(key, config.Generation, config.Raster, 1) {
		t.Fatal("frame was not presented")
	}
	if _, ok := images.PresentedFrame(key); !ok {
		t.Fatal("presented frame was not reported")
	}
	images.BeginGeneration(key.Surface)
	if frame, ok := images.PresentedFrame(key); ok {
		t.Fatalf("previous-generation frame remained current: %+v", frame)
	}
}

// contract: images.wait.continuous-raster-snapshot
func TestContinuousImageWaitIgnoresHiddenRegionsAndFailsOnPresentationError(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "surface-continuous-hidden", Name: "view"}
	var handle int
	if err := images.Reserve(key, &ImageOwner{SidecarName: "sidecar", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	if !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatal("image was not attached")
	}
	if _, err := images.ConfigureRaster(key, 800, 600, 2, false); err != nil {
		t.Fatalf("configure hidden image: %v", err)
	}
	if err := layoutWait(t, images, false); err != nil {
		t.Fatalf("hidden image blocked continuous wait: %v", err)
	}
	images.SetSurfaceVisible(key.Surface, false)
	if err := layoutWait(t, images, false); err != nil {
		t.Fatalf("hidden surface blocked continuous wait: %v", err)
	}

	visibleKey := ImageKey{Surface: "surface-continuous-error", Name: "view"}
	if err := images.Reserve(visibleKey, &ImageOwner{SidecarName: "sidecar", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	if !images.Set(visibleKey, unsafe.Pointer(&handle)) {
		t.Fatal("visible image was not attached")
	}
	config, err := images.ConfigureRaster(visibleKey, 800, 600, 2, true)
	if err != nil || config == nil {
		t.Fatalf("configure visible raster: %+v, %v", config, err)
	}
	if reason := images.AuthorizeFrame(visibleKey, "sidecar", config.Generation, config.Raster, 800, 600, 2, 1); reason != "" {
		t.Fatalf("authorize visible frame: %s", reason)
	}
	images.MarkPresentationFailed(visibleKey, config.Generation, config.Raster, 1, "continuous presentation failed")
	if err := layoutWait(t, images, false); err == nil || err.Error() != "continuous presentation failed" {
		t.Fatalf("presentation failure returned %v", err)
	}
}

// The wait of the current raster has no time limit and checks again at each change of the images; it calls waiting at each
// check that finds a raster pending, under the owner lock, which marks the points where the wait is still open.
// contract: images.wait.newer-sequence-rearms-wait, images.wait.ends-by-its-events
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
	checks := make(chan struct{}, 4)
	done := make(chan error, 1)
	wait := func() {
		go func() { done <- images.waitCurrentObserved(nil, func() { checks <- struct{}{} }) }()
	}
	expectOpen := func(what string) {
		t.Helper()
		select {
		case outcome := <-done:
			t.Fatalf("%s ended with %v", what, outcome)
		default:
		}
	}
	present := func(sequence, last int) {
		images.mu.Lock()
		state := images.states[key]
		state.PresentedRaster = config.Raster
		state.PresentedSequence = sequence
		state.LastSequence = last
		images.changedLocked()
		images.mu.Unlock()
	}
	wait()
	<-checks
	// Present the first frame and accept a newer one under one hold of the owner lock, so the wait checks after both.
	present(1, 2)
	<-checks
	expectOpen("the wait of a pending newer frame")
	if images.CurrentPresented() {
		t.Fatal("instantaneous status omitted the pending newer frame")
	}
	present(2, 2)
	if outcome := <-done; outcome != nil {
		t.Fatalf("the wait ended with %v after the newer frame presented", outcome)
	}
	// A new wait requires a frame that was accepted before it began.
	present(2, 3)
	wait()
	<-checks
	expectOpen("a new wait of the already accepted frame")
	present(3, 3)
	if outcome := <-done; outcome != nil {
		t.Fatalf("the new wait ended with %v after its frame presented", outcome)
	}
}

// contract: exposure.window.region-reports-presented-frames
func TestWindowRegionCountsTheFramesThatTheHostMarkedPresented(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "tab-1", Name: "view"}
	var handle int
	attach := func() {
		if err := images.Reserve(key, &ImageOwner{SidecarName: "sidecar-a", SidecarOwner: imageStatusTestOwner{}}); err != nil {
			t.Fatal(err)
		}
		if !images.Set(key, unsafe.Pointer(&handle)) {
			t.Fatal("image was not attached")
		}
	}
	facts := `{"frame":{"x":0,"y":0,"width":400,"height":300},"visible":true,"focused":false,` +
		`"presented":{"width":800,"height":600,"scale":2},"error":null}`
	presentedFrames := func(want float64, after string) {
		t.Helper()
		region, err := windowRegion(key, facts, images)
		if err != nil {
			t.Fatalf("%s: window region: %v", after, err)
		}
		text, err := json.Marshal(region)
		if err != nil {
			t.Fatal(err)
		}
		var entry map[string]any
		if err := json.Unmarshal(text, &entry); err != nil {
			t.Fatal(err)
		}
		if got, ok := entry["presentedFrames"]; !ok || got != want {
			t.Fatalf("%s: host.window region entry %s has presentedFrames %v (present %t), want %v", after, text, got, ok, want)
		}
	}
	present := func(config *ImageConfigure, sequence int) bool {
		t.Helper()
		if reason := images.AuthorizeFrame(key, "sidecar-a", config.Generation, config.Raster, config.Width, config.Height, config.Scale, sequence); reason != "" {
			t.Fatalf("authorize frame %d: %s", sequence, reason)
		}
		return images.MarkPresented(key, config.Generation, config.Raster, sequence)
	}

	attach()
	presentedFrames(0, "a new region")
	config, err := images.ConfigureRaster(key, 800, 600, 2, true)
	if err != nil || config == nil {
		t.Fatalf("configure raster: %+v, %v", config, err)
	}
	if !present(config, 1) || !present(config, 2) {
		t.Fatal("a current frame was not marked presented")
	}
	presentedFrames(2, "two presented frames")
	// A frame that the host does not mark presented is not counted.
	if images.MarkPresented(key, config.Generation, config.Raster, 2) {
		t.Fatal("a frame was marked presented twice")
	}
	presentedFrames(2, "a refused presentation mark")
	// A raster change does not restart the count, because the count belongs to the region.
	config, err = images.ConfigureRaster(key, 900, 600, 2, true)
	if err != nil || config == nil {
		t.Fatalf("configure the new raster: %+v, %v", config, err)
	}
	if !present(config, 1) {
		t.Fatal("a frame of the new raster was not marked presented")
	}
	presentedFrames(3, "a frame of a new raster")
	// A region attached again under the same name is a new region and counts from 0.
	if _, err := images.Remove(key); err != nil {
		t.Fatal(err)
	}
	attach()
	presentedFrames(0, "a region attached again")
}

// regionsProbe is a window of the real platform with a surface that holds one image region and one document region, both of the real
// platform, whose blur the platform reads back. The regions and the window close with the test.
type regionsProbe struct {
	*viewProbe
	image    unsafe.Pointer
	document unsafe.Pointer
}

func newRegionsProbe(t *testing.T) *regionsProbe {
	t.Helper()
	probe := &regionsProbe{viewProbe: newViewProbe(t, Theme{})}
	folder, err := filepath.Abs(filepath.Join("testdata", "view-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	runOnMainThread(func() {
		probe.image, err = system.CreateImage(probe.surface, "viewer", func(string) {}, nil)
		if err != nil {
			return
		}
		probe.document, err = system.CreateDocument(probe.surface, platform.DocumentOptions{Directory: viewStoreDirectory(t), Folder: folder, Plugin: "probe",
			Label: ProcessLabel("probe", "page")}, func(string) {})
	})
	if err != nil {
		t.Fatalf("create the regions: %v", err)
	}
	t.Cleanup(func() {
		runOnMainThread(func() {
			system.CloseImage(probe.image)
			system.CloseDocument(probe.document)
		})
	})
	return probe
}

// imageBlurred reads the blur of the image region from the facts that the platform reads of it.
func (p *regionsProbe) imageBlurred(t *testing.T) bool {
	t.Helper()
	var blurred bool
	runOnMainThread(func() { blurred = nativeImageBlurred(t, p.image) })
	return blurred
}

// nativeImageBlurred reads the blur of the image region from the facts that the platform reads of it. It runs on the main thread.
func nativeImageBlurred(t *testing.T, image unsafe.Pointer) bool {
	facts, err := system.FactsImage(image)
	if err != nil {
		t.Errorf("the facts of the image region: %v", err)
		return false
	}
	var read struct{ Blurred bool }
	if err := json.Unmarshal([]byte(facts), &read); err != nil {
		t.Errorf("the facts of the image region are not JSON: %v: %s", err, facts)
	}
	return read.Blurred
}

// moreImage creates another image region of the real platform in the surface, which closes with the test.
func (p *regionsProbe) moreImage(t *testing.T, name string) unsafe.Pointer {
	t.Helper()
	var image unsafe.Pointer
	var err error
	runOnMainThread(func() { image, err = system.CreateImage(p.surface, name, func(string) {}, nil) })
	if err != nil {
		t.Fatalf("create the image region %s: %v", name, err)
	}
	t.Cleanup(func() { runOnMainThread(func() { system.CloseImage(image) }) })
	return image
}

// documentBlurred reads the blur of the document region from the facts that the platform reads of the window: the document is the web
// view of a document region of the window.
func (p *regionsProbe) documentBlurred(t *testing.T) bool {
	t.Helper()
	var facts string
	var err error
	runOnMainThread(func() { facts, err = system.WindowFacts(p.window) })
	if err != nil {
		t.Fatalf("the facts of the window: %v", err)
	}
	var read struct {
		Webviews []struct{ Document, Blurred bool }
	}
	if err := json.Unmarshal([]byte(facts), &read); err != nil {
		t.Fatalf("the facts of the window are not JSON: %v: %s", err, facts)
	}
	for _, view := range read.Webviews {
		if view.Document {
			return view.Blurred
		}
	}
	t.Fatalf("the window holds no document region: %s", facts)
	return false
}

// contract: modal.dialog-blurs-each-document-and-image-region
func TestADialogBlursEachDocumentAndImageRegion(t *testing.T) {
	probe := newRegionsProbe(t)
	surfaces := &Surfaces{invoke: func(task func()) { task() }, documents: NewDocuments(), images: NewImages()}
	key := ImageKey{Surface: "probe-surface", Name: "viewer"}
	if err := surfaces.images.Reserve(key, &ImageOwner{SidecarName: "viewer-sidecar", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	if !surfaces.images.Set(key, probe.image) {
		t.Fatal("the image region was not attached")
	}
	documentKey := DocumentKey{Surface: "probe-surface", Name: "page"}
	if err := surfaces.documents.Reserve(documentKey); err != nil {
		t.Fatal(err)
	}
	if !surfaces.documents.Set(documentKey, probe.document) {
		t.Fatal("the document region was not attached")
	}
	for _, enabled := range []bool{true, false} {
		runOnMainThread(func() { surfaces.setWorkbenchDialog(enabled) })
		if blurred := probe.imageBlurred(t); blurred != enabled {
			t.Fatalf("the dialog is %t and the image region has the background %t", enabled, blurred)
		}
		if blurred := probe.documentBlurred(t); blurred != enabled {
			t.Fatalf("the dialog is %t and the document region has the background %t", enabled, blurred)
		}
	}
}

// contract: modal.region-under-a-dialog-starts-blurred
func TestAnImageRegionMadeUnderADialogStartsBlurred(t *testing.T) {
	probe := newRegionsProbe(t)
	for _, dialog := range []bool{true, false} {
		runOnMainThread(func() {
			probe.s.setWorkbenchDialog(dialog)
			probe.s.seatImageBackground(probe.image)
		})
		if blurred := probe.imageBlurred(t); blurred != dialog {
			t.Fatalf("a region made with the dialog %t has the background %t", dialog, blurred)
		}
	}
}

// contract: window.facts.region-reports-its-blur
func TestWindowRegionReportsItsNativeBlur(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "tab-a", Name: "viewer"}
	if err := images.Reserve(key, &ImageOwner{SidecarName: "viewer-sidecar", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	var handle byte
	if !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatal("the image region was not attached")
	}
	for _, blurred := range []bool{true, false} {
		facts := fmt.Sprintf(`{"frame":{"x":0,"y":0,"width":400,"height":300},"visible":true,"focused":false,"blurred":%t,"presented":null,"error":null}`, blurred)
		region, err := windowRegion(key, facts, images)
		if err != nil {
			t.Fatal(err)
		}
		text, err := json.Marshal(region)
		if err != nil {
			t.Fatal(err)
		}
		var entry map[string]any
		if err := json.Unmarshal(text, &entry); err != nil {
			t.Fatal(err)
		}
		if entry["blurred"] != blurred {
			t.Fatalf("host.window region entry %s of facts with blurred %t", text, blurred)
		}
	}
}

// The end of the connection of a sidecar ends the raster wait of its regions, because no raster of the ended connection comes
// (docs/spec/native-surfaces.md#layout-transaction). The end is sent after the wait reports its first pending check, and the
// result is read after the end, so no check depends on time.
// contract: images.wait.sidecar-end-ends-wait
func TestTheEndOfASidecarEndsTheRasterWaitOfItsRegions(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "surface", Name: "view"}
	var handle int
	if err := images.Reserve(key, &ImageOwner{SidecarName: "sidecar", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	if !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatal("image was not attached")
	}
	if config, err := images.ConfigureRaster(key, 800, 600, 2, true); err != nil || config == nil {
		t.Fatalf("configure raster: %+v, %v", config, err)
	}
	images.mu.Lock()
	images.states[key].LastSequence = 1
	images.mu.Unlock()
	started := make(chan struct{}, 8)
	done := make(chan error, 1)
	go func() { done <- images.waitCurrentObserved(nil, func() { started <- struct{}{} }) }()
	<-started
	if ended := images.InvalidateSidecar("sidecar"); ended != 1 {
		t.Fatalf("the end of the sidecar invalidated %d regions, want 1", ended)
	}
	if err := <-done; err == nil || !strings.Contains(err.Error(), "sidecar") {
		t.Fatalf("the raster wait ended with %v, want the end of its sidecar", err)
	}
}

// The end of the layout transaction of the window ends its raster wait, as a press or key event that ends the hold does
// (docs/spec/native-surfaces.md#layout-transaction).
// contract: images.wait.sidecar-end-ends-wait
func TestTheEndOfTheLayoutEndsTheRasterWait(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "surface", Name: "view"}
	var handle int
	if err := images.Reserve(key, &ImageOwner{SidecarName: "sidecar", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	if !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatal("image was not attached")
	}
	if config, err := images.ConfigureRaster(key, 800, 600, 2, true); err != nil || config == nil {
		t.Fatalf("configure raster: %+v, %v", config, err)
	}
	images.mu.Lock()
	images.states[key].LastSequence = 1
	images.mu.Unlock()
	started := make(chan struct{}, 8)
	done := make(chan error, 1)
	go func() { done <- images.waitLayoutRastersObserved(true, func() { started <- struct{}{} }) }()
	<-started
	images.EndWaits()
	if err := <-done; !errors.Is(err, errLayoutWaitEnded) {
		t.Fatalf("the raster wait ended with %v, want the end of the layout", err)
	}
}

// The wait of host.window.presented for the current rasters ends by the end of its request, and the end of a layout transaction
// does not end it: the wait checks again after that end and stays open (docs/spec/host-contract.md, images.wait.ends-by-its-events).
// The end of the layout is sent after the first pending check and the stop after the second, so no check depends on time.
// contract: images.wait.ends-by-its-events
func TestTheEndOfItsRequestEndsTheWaitOfTheCurrentRasters(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "surface", Name: "view"}
	var handle int
	if err := images.Reserve(key, &ImageOwner{SidecarName: "sidecar", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	if !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatal("image was not attached")
	}
	if config, err := images.ConfigureRaster(key, 800, 600, 2, true); err != nil || config == nil {
		t.Fatalf("configure raster: %+v, %v", config, err)
	}
	images.mu.Lock()
	images.states[key].LastSequence = 1
	images.mu.Unlock()
	checks := make(chan struct{}, 8)
	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- images.waitCurrentObserved(stop, func() { checks <- struct{}{} }) }()
	<-checks
	images.EndWaits()
	<-checks
	select {
	case err := <-done:
		t.Fatalf("the end of a layout transaction ended the wait of the current rasters with %v", err)
	default:
	}
	close(stop)
	if err := <-done; !errors.Is(err, errRasterWaitStopped) {
		t.Fatalf("the wait of the current rasters ended with %v, want the end of its request", err)
	}
}

// contract: images.copy-path.screen-request
// A drawing region receives one screen request for its current screen until the host answers it, and the request that follows an
// accepted screen carries only the changed rows (docs/spec/native-surfaces.md#copy-path-frames).
func TestDrawingRegionReceivesOneScreenRequestUntilItIsAnswered(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "tab-1", Name: "copy"}
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
	requests := images.ScreenRequests()
	if len(requests) != 1 {
		t.Fatalf("a drawing region got %d screen requests, want 1", len(requests))
	}
	first := requests[0]
	if !first.Full || first.Generation != raster.Generation || first.Raster != raster.Raster {
		t.Fatalf("first screen request %+v: want full for generation %d raster %d", first, raster.Generation, raster.Raster)
	}
	body, err := json.Marshal(map[string]any{"image": map[string]any{"screen": first}})
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(`{"image":{"screen":{"request":%q,"name":"copy","generation":%d,"raster":%d,"full":true}}}`,
		first.Request, raster.Generation, raster.Raster)
	if string(body) != want {
		t.Fatalf("screen request body = %s, want %s", body, want)
	}
	if again := images.ScreenRequests(); len(again) != 0 {
		t.Fatalf("a region with an unanswered screen request got another one: %+v", again)
	}
	if err := images.AnswerScreen(key, first, true); err != nil {
		t.Fatalf("answer screen request: %v", err)
	}
	next := images.ScreenRequests()
	if len(next) != 1 || next[0].Full || next[0].Request == first.Request {
		t.Fatalf("after an accepted screen the next request is %+v: want one request with full false and a new identifier", next)
	}
}

// contract: images.copy-path.clock-tick
// The window clock ticks each drawing region with the generation of the region, the sequence of the tick from 1 and the refresh rate that
// the caller read at the tick. A region that is not drawing receives no tick (docs/spec/native-surfaces.md#copy-path-frames).
func TestWindowClockTicksEachDrawingRegionWithItsSequence(t *testing.T) {
	images := NewImages()
	if ticks := images.Tick(120); len(ticks) != 0 {
		t.Fatalf("a window without image regions got ticks: %+v", ticks)
	}
	var handle int
	for _, region := range []struct {
		name    string
		visible bool
	}{{"copy", true}, {"idle", false}} {
		key := ImageKey{Surface: "tab-1", Name: region.name}
		if err := images.Reserve(key, &ImageOwner{SidecarName: "sidecar-a", SidecarOwner: imageStatusTestOwner{}}); err != nil {
			t.Fatal(err)
		}
		if !images.Set(key, unsafe.Pointer(&handle)) {
			t.Fatal("image was not attached")
		}
		if _, err := images.ConfigureRaster(key, 800, 600, 2, region.visible); err != nil {
			t.Fatalf("configure image %s: %v", region.name, err)
		}
	}
	ticks := images.Tick(120)
	if len(ticks) != 1 || ticks[0].Name != "copy" || ticks[0].Sequence != 2 || ticks[0].RefreshRate != 120 {
		t.Fatalf("tick after one earlier tick = %+v, want one tick of copy with sequence 2 and refresh rate 120", ticks)
	}
	body, err := json.Marshal(map[string]any{"image": map[string]any{"tick": ticks[0]}})
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(`{"image":{"tick":{"name":"copy","generation":%d,"sequence":2,"refreshRate":120}}}`, ticks[0].Generation)
	if string(body) != want {
		t.Fatalf("tick body = %s, want %s", body, want)
	}
}

// contract: images.copy-path.input-draw
// A user input that reaches a drawing region sends the screen request at once when the input is at most 200 ms old and the region has no
// unanswered request. The request carries the correlation identifiers of the input (docs/spec/native-surfaces.md#copy-path-frames).
func TestInputSendsTheScreenRequestAtOnceWithItsCorrelationIdentifiers(t *testing.T) {
	images := NewImages()
	key := ImageKey{Surface: "tab-1", Name: "copy"}
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
	inputAt := time.Unix(100, 0)
	request, sent := images.InputScreenRequest(key, []string{"cid-1"}, inputAt, inputAt.Add(150*time.Millisecond))
	if !sent || !reflect.DeepEqual(request.Cids, []string{"cid-1"}) {
		t.Fatalf("input 150 ms old: sent %t request %+v, want a request with cids [cid-1]", sent, request)
	}
	body, err := json.Marshal(map[string]any{"image": map[string]any{"screen": request}})
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(`{"image":{"screen":{"request":%q,"name":"copy","generation":%d,"raster":%d,"full":true,"cids":["cid-1"]}}}`,
		request.Request, raster.Generation, raster.Raster)
	if string(body) != want {
		t.Fatalf("input screen request body = %s, want %s", body, want)
	}
	if _, sent := images.InputScreenRequest(key, []string{"cid-2"}, inputAt, inputAt.Add(10*time.Millisecond)); sent {
		t.Fatal("an input sent a screen request while the region had an unanswered one")
	}
	if err := images.AnswerScreen(key, request, false); err != nil {
		t.Fatalf("answer screen request: %v", err)
	}
	if _, sent := images.InputScreenRequest(key, []string{"cid-3"}, inputAt, inputAt.Add(201*time.Millisecond)); sent {
		t.Fatal("an input 201 ms old sent a screen request at once")
	}
}

// screenFixture returns a window with one drawing region of sidecar-a and the unanswered screen request of the region.
func screenFixture(t *testing.T) (*Images, ImageKey, *ImageConfigure, ImageScreenRequest) {
	t.Helper()
	images := NewImages()
	key := ImageKey{Surface: "tab-1", Name: "copy"}
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
	requests := images.ScreenRequests()
	if len(requests) != 1 {
		t.Fatalf("a drawing region got %d screen requests, want 1", len(requests))
	}
	return images, key, raster, requests[0]
}

// handleScreenMessage sends a supplier body through HandleEnvelope and returns whether the host consumed it and each answer it sent.
func handleScreenMessage(images *Images, body []byte, sender, surface string) (bool, []string, error) {
	var answers []string
	var sendErr error
	handled := HandleEnvelope(body, sender, surface, images,
		func(work func() error) error { return work() },
		func(_ string, response map[string]interface{}) error {
			answer, err := json.Marshal(response)
			if err != nil {
				sendErr = err
				return err
			}
			answers = append(answers, string(answer))
			return nil
		},
		func(string) error { return nil },
		func() bool { return true },
		func() {},
	)
	return handled, answers, sendErr
}

func screenMessageBody(t *testing.T, member map[string]any) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{"image": map[string]any{"screen": member}})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// contract: images.copy-path.screen-answer-accepted
// The screen message that answers the unanswered request of a region is accepted at the wire: the host answers accepted, the rows become the
// baseline, and the next request sends only the changed rows (docs/spec/native-surfaces.md#copy-path-frames).
func TestScreenMessageOfTheSupplierIsAcceptedOverTheWire(t *testing.T) {
	images, key, raster, first := screenFixture(t)
	body := screenMessageBody(t, map[string]any{
		"request": first.Request, "name": "copy", "generation": raster.Generation, "raster": raster.Raster,
		"rows": []any{map[string]any{"row": 0, "cells": "row-0"}},
	})
	handled, answers, err := handleScreenMessage(images, body, "sidecar-a", key.Surface)
	if err != nil || !handled {
		t.Fatalf("screen message handled %t, error %v; want handled without error", handled, err)
	}
	want := fmt.Sprintf(`{"image":{"screen":{"accepted":{"generation":%d,"name":"copy","raster":%d,"request":%q}}}}`,
		raster.Generation, raster.Raster, first.Request)
	if !reflect.DeepEqual(answers, []string{want}) {
		t.Fatalf("answers to the screen message = %v, want [%s]", answers, want)
	}
	next := images.ScreenRequests()
	if len(next) != 1 || next[0].Full || next[0].Request == first.Request {
		t.Fatalf("after the accepted screen the next request is %+v, want one request with full false and a new identifier", next)
	}
}

// contract: images.copy-path.screen-answer-refused
// A screen message with an out-of-date generation or raster, with a request that is not the unanswered one, or from a sender that does not
// own the region is answered stale or notAttached; the unanswered request of the region stays unanswered (docs/spec/native-surfaces.md#copy-path-frames).
func TestScreenMessageRefusalsNameTheReasonAndKeepTheRequest(t *testing.T) {
	cases := []struct {
		name       string
		sender     string
		generation func(uint64) uint64
		raster     func(uint64) uint64
		request    func(ImageScreenRequest) string
		reason     string
	}{
		{"stale generation", "sidecar-a", func(g uint64) uint64 { return g + 1 }, func(r uint64) uint64 { return r }, func(q ImageScreenRequest) string { return q.Request }, "stale"},
		{"stale raster", "sidecar-a", func(g uint64) uint64 { return g }, func(r uint64) uint64 { return r + 1 }, func(q ImageScreenRequest) string { return q.Request }, "stale"},
		{"superseded request", "sidecar-a", func(g uint64) uint64 { return g }, func(r uint64) uint64 { return r }, func(ImageScreenRequest) string { return "screen-old" }, "stale"},
		{"other sender", "sidecar-b", func(g uint64) uint64 { return g }, func(r uint64) uint64 { return r }, func(q ImageScreenRequest) string { return q.Request }, "notAttached"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			images, key, raster, first := screenFixture(t)
			body := screenMessageBody(t, map[string]any{
				"request": tc.request(first), "name": "copy", "generation": tc.generation(raster.Generation), "raster": tc.raster(raster.Raster),
				"rows": []any{map[string]any{"row": 0, "cells": "row-0"}},
			})
			handled, answers, err := handleScreenMessage(images, body, tc.sender, key.Surface)
			if err != nil || !handled {
				t.Fatalf("screen message handled %t, error %v; want handled without error", handled, err)
			}
			want := fmt.Sprintf(`{"image":{"screen":{"error":%q,"generation":%d,"name":"copy","raster":%d,"request":%q}}}`,
				tc.reason, tc.generation(raster.Generation), tc.raster(raster.Raster), tc.request(first))
			if !reflect.DeepEqual(answers, []string{want}) {
				t.Fatalf("answers to the screen message = %v, want [%s]", answers, want)
			}
			if again := images.ScreenRequests(); len(again) != 0 {
				t.Fatalf("a refused screen message ended the unanswered request: next request %+v", again)
			}
		})
	}
}

// contract: images.copy-path.screen-malformed-names-its-member
// A screen message with a member that is missing or has the wrong type is rejected with an error that names the member, and the host sends no answer.
func TestMalformedScreenMessageNamesItsMember(t *testing.T) {
	images, key, raster, first := screenFixture(t)
	valid := func() map[string]any {
		return map[string]any{
			"request": first.Request, "name": "copy", "generation": raster.Generation, "raster": raster.Raster,
			"rows": []any{map[string]any{"row": 0, "cells": "row-0"}},
		}
	}
	cases := []struct {
		name   string
		member string
		change func(map[string]any)
		want   string
	}{
		{"missing request", "request", func(m map[string]any) { delete(m, "request") }, "image screen message has no request"},
		{"string generation", "generation", func(m map[string]any) { m["generation"] = "2" }, "image screen message has no valid generation"},
		{"negative raster", "raster", func(m map[string]any) { m["raster"] = -1 }, "image screen message has no valid raster"},
		{"missing rows", "rows", func(m map[string]any) { delete(m, "rows") }, "image screen message has no rows array"},
		{"row without cells", "rows.0.cells", func(m map[string]any) { m["rows"] = []any{map[string]any{"row": 0}} }, "image screen message row 0 has no cells"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			member := valid()
			tc.change(member)
			body := screenMessageBody(t, member)
			decision := Decide(body, "sidecar-a", key.Surface, images)
			malformed, ok := decision.(error)
			if !ok || !strings.Contains(malformed.Error(), tc.want) {
				t.Fatalf("decision of the malformed screen message = %T %v, want an error that names %q", decision, decision, tc.want)
			}
			handled, answers, err := handleScreenMessage(images, body, "sidecar-a", key.Surface)
			if err != nil || !handled || len(answers) != 1 {
				t.Fatalf("malformed screen message handled %t, answers %v, error %v; want handled with one answer", handled, answers, err)
			}
			var answer struct {
				Image struct {
					Screen map[string]any `json:"screen"`
				} `json:"image"`
			}
			if err := json.Unmarshal([]byte(answers[0]), &answer); err != nil {
				t.Fatalf("malformed answer %s: %v", answers[0], err)
			}
			if answer.Image.Screen["error"] != "malformed" || answer.Image.Screen["member"] != tc.member {
				t.Fatalf("malformed answer %s, want error malformed naming member %q", answers[0], tc.member)
			}
			if again := images.ScreenRequests(); len(again) != 0 {
				t.Fatalf("a malformed screen message ended the unanswered request: next request %+v", again)
			}
		})
	}
}

// contract: images.copy-path.screen-without-name-is-not-answered
// A screen message without a valid image name is consumed and sends no answer, because the answer is routed by the image name.
func TestScreenMessageWithoutNameIsNotAnswered(t *testing.T) {
	images, key, raster, first := screenFixture(t)
	member := map[string]any{
		"request": first.Request, "generation": raster.Generation, "raster": raster.Raster,
		"rows": []any{map[string]any{"row": 0, "cells": "row-0"}},
	}
	body := screenMessageBody(t, member)
	decision := Decide(body, "sidecar-a", key.Surface, images)
	malformed, ok := decision.(error)
	if !ok || !strings.Contains(malformed.Error(), "image screen message has no image name") {
		t.Fatalf("decision of the screen message without a name = %T %v, want an error that names the image name", decision, decision)
	}
	handled, answers, err := handleScreenMessage(images, body, "sidecar-a", key.Surface)
	if err != nil || !handled || len(answers) != 0 {
		t.Fatalf("screen message without a name handled %t, answers %v, error %v; want handled with no answer", handled, answers, err)
	}
}
