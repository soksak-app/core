package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
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
