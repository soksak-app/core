package host_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

const imageSidecar = "@fixture/sidecar-echo"

func configureImage(t *testing.T, images *host.Images, key host.ImageKey, width, height int, scale float64) *host.ImageConfigure {
	t.Helper()
	configuration, err := images.ConfigureRaster(key, width, height, scale, true)
	if err != nil || configuration == nil {
		t.Fatalf("configure image: %+v %v", configuration, err)
	}
	return configuration
}

func configuredEnvelope(t *testing.T, configuration *host.ImageConfigure, sequence int) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{"image": map[string]any{
		"name": configuration.Name,
		"token": map[string]any{
			"kind": "iosurface-global", "id": uint32(12345), "nonce": "AAAAAAAAAAAAAAAAAAAAAA==",
		},
		"width": configuration.Width, "height": configuration.Height, "scale": configuration.Scale,
		"format": "bgra8", "generation": configuration.Generation, "raster": configuration.Raster,
		"sequence": sequence,
	}})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// declareImages is the declaration of one sidecar installed in directory.
func declareImages(directory, sidecar string) []host.SidecarDeclaration {
	return []host.SidecarDeclaration{{Name: imageSidecar, Folder: directory, Data: []byte(sidecar)}}
}

// fakeImageOwner is a window that records the sidecar events it received.
type fakeImageOwner struct {
	root   string
	mu     sync.Mutex
	events []host.SidecarMessage
	seen   chan struct{}
}

func newFakeImageOwner(root string) *fakeImageOwner {
	return &fakeImageOwner{root: root, seen: make(chan struct{}, 16)}
}

func (o *fakeImageOwner) ProjectRoot() string { return o.root }

func (o *fakeImageOwner) Emit(name string, data ...any) {
	if name != "sidecar-message" || len(data) != 1 {
		return
	}
	o.mu.Lock()
	o.events = append(o.events, data[0].(host.SidecarMessage))
	o.mu.Unlock()
	o.seen <- struct{}{}
}

func (o *fakeImageOwner) next(t *testing.T) host.SidecarMessage {
	t.Helper()
	select {
	case <-o.seen:
	case <-time.After(stall):
		t.Fatalf("no sidecar event within %v; the test stalled", stall)
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.events[len(o.events)-1]
}

// echoSidecarsForImages creates a channel that declares a fake sidecar that outputs the lines it received as they are.
func echoSidecarsForImages(t *testing.T) (*host.Sidecars, string) {
	t.Helper()
	directory := t.TempDir()
	record := filepath.Join(directory, "requests")
	script := "#!/bin/sh\ncat | tee " + record + "\n"
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declareImages(directory, `{"executable":"echo","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	return sidecars, record
}

// contract: images.envelope.rejects-unattached-image, images.envelope.refusal-echoes-name-and-sequence
func TestUnattachedImageIsRefused(t *testing.T) {
	images := host.NewImages()
	nonce := "AAAAAAAAAAAAAAAAAAAAAA==" // 16 zero bytes
	body := map[string]any{
		"image": map[string]any{
			"name": "view",
			"token": map[string]any{
				"kind":  "iosurface-global",
				"id":    uint32(12345),
				"nonce": nonce,
			},
			"width":      800,
			"height":     600,
			"scale":      2.0,
			"format":     "bgra8",
			"generation": uint64(1),
			"raster":     uint64(1),
			"sequence":   1,
		},
	}
	bodyBytes, _ := json.Marshal(body)

	// Since the image is not registered, it must return a notAttached error
	decision := host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	reply, ok := decision.(*host.Reply)
	if !ok {
		t.Fatalf("expected Reply(notAttached), got %T", decision)
	}
	imageData := reply.JSON["image"].(map[string]interface{})
	if !strings.Contains(imageData["error"].(string), "notAttached") {
		t.Fatalf("expected notAttached error, got %v", imageData["error"])
	}
	// The rejection reply returns the name and the sequence number of the envelope as they are.
	if reply.Name != "view" || imageData["name"] != "view" || imageData["sequence"] != 1 {
		t.Fatalf("refusal did not echo name and sequence: reply name %q, image %v", reply.Name, imageData)
	}
}

// contract: images.envelope.rejects-other-sidecar
func TestImageFromAnotherSidecarIsRefused(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}

	var a int
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	if err := images.Reserve(key, owner); err != nil {
		t.Fatalf("reserve failed: %v", err)
	}
	images.Set(key, unsafe.Pointer(&a))
	configureImage(t, images, key, 800, 600, 2.0)

	nonce := "AAAAAAAAAAAAAAAAAAAAAA=="
	body := map[string]any{
		"image": map[string]any{
			"name": "view",
			"token": map[string]any{
				"kind":  "iosurface-global",
				"id":    uint32(12345),
				"nonce": nonce,
			},
			"width":      800,
			"height":     600,
			"scale":      2.0,
			"format":     "bgra8",
			"generation": uint64(1),
			"raster":     uint64(1),
			"sequence":   1,
		},
	}
	bodyBytes, _ := json.Marshal(body)

	// When another sidecar sends the same image, it must return a notAttached error
	decision := host.Decide(bodyBytes, "sidecar-b", "tab-1", images)
	reply, ok := decision.(*host.Reply)
	if !ok {
		t.Fatalf("expected Reply(notAttached) for different sidecar, got %T", decision)
	}
	imageData := reply.JSON["image"].(map[string]interface{})
	if !strings.Contains(imageData["error"].(string), "notAttached") {
		t.Fatalf("expected notAttached error, got %v", imageData["error"])
	}
}

// contract: images.envelope.presents-attached-current-frame, images.envelope.present-carries-nonce-scale-generation-raster
func TestAttachedImageIsPresented(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}

	var a int
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	if err := images.Reserve(key, owner); err != nil {
		t.Fatalf("reserve failed: %v", err)
	}
	images.Set(key, unsafe.Pointer(&a))
	configured := configureImage(t, images, key, 800, 600, 2.0)

	// 16 bytes from 0 to 15. The values must be non-zero so that a copy of the nonce can be told apart.
	nonce := "AAECAwQFBgcICQoLDA0ODw=="
	body := map[string]any{
		"image": map[string]any{
			"name": "view",
			"token": map[string]any{
				"kind":  "iosurface-global",
				"id":    uint32(12345),
				"nonce": nonce,
			},
			"width":      800,
			"height":     600,
			"scale":      2.0,
			"format":     "bgra8",
			"generation": uint64(1),
			"raster":     uint64(1),
			"sequence":   1,
		},
	}
	bodyBytes, _ := json.Marshal(body)

	// When the same sidecar sends the same image, it must return Present
	decision := host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	present, ok := decision.(*host.Present)
	if !ok {
		t.Fatalf("expected Present, got %T", decision)
	}

	if present.ID != 12345 {
		t.Fatalf("expected id 12345, got %d", present.ID)
	}
	if present.Width != 800 || present.Height != 600 {
		t.Fatalf("expected 800x600, got %dx%d", present.Width, present.Height)
	}
	if present.Name != "view" {
		t.Fatalf("expected name view, got %s", present.Name)
	}
	if present.Sequence != 1 {
		t.Fatalf("expected sequence 1, got %d", present.Sequence)
	}
	if present.Nonce != [16]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15} {
		t.Fatalf("expected nonce 0..15, got %v", present.Nonce)
	}
	if present.Scale != 2.0 {
		t.Fatalf("expected scale 2, got %v", present.Scale)
	}
	if present.Generation != configured.Generation || present.Raster != configured.Raster {
		t.Fatalf("expected generation %d raster %d, got generation %d raster %d",
			configured.Generation, configured.Raster, present.Generation, present.Raster)
	}
}

// contract: images.ack.consumed-carries-frame-identity
func TestSuccessfulPresentIsReleased(t *testing.T) {
	response := host.AfterPresent(true, "", "view", 7, 3, 1)
	image := response["image"].(map[string]interface{})
	consumed := image["consumed"].(map[string]interface{})

	if consumed["name"] != "view" {
		t.Fatalf("expected name view, got %v", consumed["name"])
	}
	if consumed["generation"] != uint64(7) || consumed["raster"] != uint64(3) {
		t.Fatalf("expected generation 7 raster 3, got %v", consumed)
	}
	if consumed["sequence"] != 1 {
		t.Fatalf("expected sequence 1, got %v", consumed["sequence"])
	}
}

// contract: images.transfer.rejects-duplicate-sequence, images.transfer.reconfigure-advances-raster, images.transfer.rejects-stale-raster, images.transfer.configure-stamps-current-generation, images.transfer.generation-advances, images.transfer.rejects-old-generation-after-reattach
func TestOnlyTheCurrentGenerationRasterAndSequenceCanBePresented(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	var handle int

	firstGeneration := images.BeginGeneration(key.Surface)
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach first generation: %v", err)
	}
	firstRaster := configureImage(t, images, key, 800, 600, 2.0)
	if firstRaster.Generation != firstGeneration {
		t.Fatalf("configuration generation %d, want %d", firstRaster.Generation, firstGeneration)
	}
	if _, ok := host.Decide(configuredEnvelope(t, firstRaster, 1), "sidecar-a", key.Surface, images).(*host.Present); !ok {
		t.Fatal("current first frame was rejected")
	}
	if reply, ok := host.Decide(configuredEnvelope(t, firstRaster, 1), "sidecar-a", key.Surface, images).(*host.Reply); !ok || reply.JSON["image"].(map[string]interface{})["error"] != "stale" {
		t.Fatalf("duplicate sequence was not stale: %#v", reply)
	}

	secondRaster := configureImage(t, images, key, 900, 600, 2.0)
	if secondRaster.Raster <= firstRaster.Raster {
		t.Fatalf("raster did not advance: %d -> %d", firstRaster.Raster, secondRaster.Raster)
	}
	if reply, ok := host.Decide(configuredEnvelope(t, firstRaster, 2), "sidecar-a", key.Surface, images).(*host.Reply); !ok || reply.JSON["image"].(map[string]interface{})["error"] != "stale" {
		t.Fatalf("old raster was not stale: %#v", reply)
	}
	if _, ok := host.Decide(configuredEnvelope(t, secondRaster, 1), "sidecar-a", key.Surface, images).(*host.Present); !ok {
		t.Fatal("current resized raster was rejected")
	}

	if _, err := images.Remove(key); err != nil {
		t.Fatal(err)
	}
	images.EndGeneration(key.Surface)
	secondGeneration := images.BeginGeneration(key.Surface)
	if secondGeneration <= firstGeneration {
		t.Fatalf("generation did not advance: %d -> %d", firstGeneration, secondGeneration)
	}
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach second generation: %v", err)
	}
	configureImage(t, images, key, 800, 600, 2.0)
	if reply, ok := host.Decide(configuredEnvelope(t, firstRaster, 3), "sidecar-a", key.Surface, images).(*host.Reply); !ok || reply.JSON["image"].(map[string]interface{})["error"] != "notAttached" {
		t.Fatalf("old generation was not rejected: %#v", reply)
	}
}

// contract: images.wait.blocks-before-first-frame, images.wait.releases-after-current-frame-presented, images.wait.successful-handle-replies-consumed, images.wait.newer-sequence-rearms-wait, images.wait.reconfigure-clears-presented, images.wait.hidden-image-does-not-block, images.wait.hidden-surface-does-not-block, images.wait.ended-generation-does-not-block
func TestPresentationWaitTracksTheVisibleCurrentRaster(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	var handle int
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach image: %v", err)
	}

	first := configureImage(t, images, key, 800, 600, 2.0)
	if images.WaitCurrent(0) {
		t.Fatal("visible raster passed before a frame was presented")
	}
	// Handles the envelope with onMain, which replies that the main thread display succeeded.
	var response map[string]interface{}
	if !host.HandleEnvelope(configuredEnvelope(t, first, 1), "sidecar-a", key.Surface, images,
		func(func() error) error { return nil },
		func(_ string, value map[string]interface{}) error {
			response = value
			return nil
		},
		noRecovery(t),
		func() bool { return true },
	) {
		t.Fatal("current frame was not handled")
	}
	if _, ok := response["image"].(map[string]interface{})["consumed"].(map[string]interface{}); !ok {
		t.Fatalf("successful presentation did not reply consumed: %v", response)
	}
	if !images.WaitCurrent(0) {
		t.Fatal("presented current raster did not release the wait")
	}
	if _, ok := host.Decide(configuredEnvelope(t, first, 2), "sidecar-a", key.Surface, images).(*host.Present); !ok {
		t.Fatal("newer sequence on the current raster was rejected")
	}
	if images.WaitCurrent(0) {
		t.Fatal("a newer sequence on the same raster did not rearm the wait")
	}

	second := configureImage(t, images, key, 900, 600, 2.0)
	if images.CurrentPresented() {
		t.Fatal("resized raster retained the previous presentation result")
	}
	if err := images.SetVisible(key, false); err != nil {
		t.Fatal(err)
	}
	if !images.WaitCurrent(0) {
		t.Fatal("hidden image blocked presentation")
	}
	if err := images.SetVisible(key, true); err != nil {
		t.Fatal(err)
	}
	if images.WaitCurrent(0) {
		t.Fatalf("visible raster %d passed without a current frame", second.Raster)
	}
	images.SetSurfaceVisible(key.Surface, false)
	if !images.WaitCurrent(0) {
		t.Fatal("an image in a hidden surface blocked presentation")
	}
	images.SetSurfaceVisible(key.Surface, true)
	if images.WaitCurrent(0) {
		t.Fatal("showing the surface did not restore the pending raster")
	}
	images.EndGeneration(key.Surface)
	if !images.WaitCurrent(0) {
		t.Fatal("an ended surface generation blocked presentation")
	}
}

// contract: images.wait.timeout-writes-no-log-line
func TestPresentationWaitTimeoutReturnsItsFailureAndWritesNoLogLine(t *testing.T) {
	if config := os.Getenv(standardErrorChild); config != "" {
		log, err := host.StartHostEventLog(config)
		if err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		host.UseHostEventLog(log)
		if err := host.StartStandardError(config, "com.soksak.test"); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		images := host.NewImages()
		key := host.ImageKey{Surface: "tab-1", Name: "view"}
		owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
		var handle int
		if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
			t.Fatalf("attach image: %v", err)
		}
		configureImage(t, images, key, 800, 600, 2.0)
		// With a time limit of 0 it ends before waiting, so a short time is given so that the path in which the wait ends at the time limit is exercised.
		if err := images.WaitCurrentError(20 * time.Millisecond); err == nil || err.Error() != "presentationTimeout" {
			t.Fatalf("the presentation wait ended with %v", err)
		}
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestPresentationWaitTimeoutReturnsItsFailureAndWritesNoLogLine$")
	command.Env = append(os.Environ(), standardErrorChild+"="+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	// The wait ended with its own failure, so the event log holds log.open and the run record and nothing else.
	events := readHostEventLog(t, config)
	if len(events) != 2 || events[1]["fields"].(map[string]any)["where"] != "run" {
		t.Fatalf("a presentation timeout wrote events: %v", events)
	}
}

// contract: images.visibility.survives-first-document-navigation
func TestSurfaceVisibilitySurvivesFirstDocumentNavigation(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "hidden", Name: "view"}
	images.SetSurfaceVisible(key.Surface, false)
	images.RemoveSurface(key.Surface)
	images.BeginGeneration(key.Surface)
	var handle int
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach image: %v", err)
	}
	configuration, err := images.ConfigureRaster(key, 1, 1, 2, true)
	if err != nil || configuration != nil || len(images.Visible()) != 0 || !images.CurrentPresented() {
		t.Fatalf("navigation lost outer surface visibility: configuration=%+v error=%v", configuration, err)
	}
}

// contract: images.visibility.hidden-surface-defers-configuration, images.visibility.refresh-list-excludes-hidden
func TestHiddenSurfaceDefersRasterConfiguration(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "hidden", Name: "view"}
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	var handle int
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach image: %v", err)
	}
	images.SetSurfaceVisible(key.Surface, false)
	configured, err := images.ConfigureRaster(key, 1, 1, 2, true)
	if err != nil || configured != nil {
		t.Fatalf("hidden surface sent raster configuration: %+v %v", configured, err)
	}
	if len(images.Visible()) != 0 {
		t.Fatal("hidden surface was included in raster refresh")
	}
	images.SetSurfaceVisible(key.Surface, true)
	if images.Visible()[key] != unsafe.Pointer(&handle) {
		t.Fatal("shown surface was omitted from raster refresh")
	}
	shown := configureImage(t, images, key, 800, 600, 2)
	if shown.Width != 800 || shown.Height != 600 {
		t.Fatalf("shown surface did not configure its visible raster: %+v", shown)
	}
	if err := images.SetVisible(key, false); err != nil {
		t.Fatal(err)
	}
	if len(images.Visible()) != 0 {
		t.Fatal("hidden region was included in raster refresh")
	}
}

// contract: images.present.rejects-frame-superseded-during-main-thread
func TestFrameThatBecomesStaleBeforeMainThreadPresentationIsRejected(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	var handle int
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach image: %v", err)
	}
	first := configureImage(t, images, key, 800, 600, 2.0)
	var response map[string]interface{}

	host.HandleEnvelope(configuredEnvelope(t, first, 1), "sidecar-a", key.Surface, images,
		func(work func() error) error {
			if _, err := images.ConfigureRaster(key, 900, 600, 2.0, true); err != nil {
				t.Fatal(err)
			}
			return work()
		},
		func(_ string, value map[string]interface{}) error {
			response = value
			return nil
		},
		noRecovery(t),
		func() bool { return true },
	)

	if got := response["image"].(map[string]interface{})["error"]; got != "stale" {
		t.Fatalf("frame superseded before presentation returned %v, want stale", got)
	}
	if images.CurrentPresented() {
		t.Fatal("stale frame marked the replacement raster as presented")
	}
}

// contract: images.ack.failure-carries-error-and-frame-identity
func TestFailedPresentIsReported(t *testing.T) {
	response := host.AfterPresent(false, "forbidden", "view", 7, 3, 1)
	image := response["image"].(map[string]interface{})

	if image["error"] != "forbidden" {
		t.Fatalf("expected error forbidden, got %v", image["error"])
	}
	if image["name"] != "view" {
		t.Fatalf("expected name view, got %v", image["name"])
	}
	if image["generation"] != uint64(7) || image["raster"] != uint64(3) {
		t.Fatalf("expected generation 7 raster 3, got %v", image)
	}
	if image["sequence"] != 1 {
		t.Fatalf("expected sequence 1, got %v", image["sequence"])
	}
}

// contract: images.envelope.rejects-unsupported-format, images.envelope.rejects-bad-nonce-length, images.envelope.rejects-unknown-token-kind
func TestUnsupportedImageIsRefused(t *testing.T) {
	images := host.NewImages()

	// The case of a wrong format
	bodyWrongFormat := map[string]any{
		"image": map[string]any{
			"name": "view",
			"token": map[string]any{
				"kind":  "iosurface-global",
				"id":    uint32(12345),
				"nonce": "AAAAAAAAAAAAAAAAAAAAAA==",
			},
			"width":      800,
			"height":     600,
			"scale":      2.0,
			"format":     "rgba8", // A wrong format
			"generation": uint64(1),
			"raster":     uint64(1),
			"sequence":   1,
		},
	}
	bodyBytes, _ := json.Marshal(bodyWrongFormat)

	decision := host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	reply, ok := decision.(*host.Reply)
	if !ok {
		t.Fatalf("expected Reply(unsupported) for wrong format, got %T", decision)
	}
	imageData := reply.JSON["image"].(map[string]interface{})
	if !strings.Contains(imageData["error"].(string), "unsupported") {
		t.Fatalf("expected unsupported error, got %v", imageData["error"])
	}

	// The case of a wrong nonce length
	bodyWrongNonce := map[string]any{
		"image": map[string]any{
			"name": "view",
			"token": map[string]any{
				"kind":  "iosurface-global",
				"id":    uint32(12345),
				"nonce": "short", // Not 16 bytes
			},
			"width":      800,
			"height":     600,
			"scale":      2.0,
			"format":     "bgra8",
			"generation": uint64(1),
			"raster":     uint64(1),
			"sequence":   1,
		},
	}
	bodyBytes, _ = json.Marshal(bodyWrongNonce)

	decision = host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	reply, ok = decision.(*host.Reply)
	if !ok {
		t.Fatalf("expected Reply(unsupported) for wrong nonce length, got %T", decision)
	}
	imageData = reply.JSON["image"].(map[string]interface{})
	if !strings.Contains(imageData["error"].(string), "unsupported") {
		t.Fatalf("expected unsupported error, got %v", imageData["error"])
	}

	// The case of a wrong token.kind
	bodyWrongKind := map[string]any{
		"image": map[string]any{
			"name": "view",
			"token": map[string]any{
				"kind":  "other-kind",
				"id":    uint32(12345),
				"nonce": "AAAAAAAAAAAAAAAAAAAAAA==",
			},
			"width":      800,
			"height":     600,
			"scale":      2.0,
			"format":     "bgra8",
			"generation": uint64(1),
			"raster":     uint64(1),
			"sequence":   1,
		},
	}
	bodyBytes, _ = json.Marshal(bodyWrongKind)

	decision = host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	reply, ok = decision.(*host.Reply)
	if !ok {
		t.Fatalf("expected Reply(unsupported) for wrong token kind, got %T", decision)
	}
	imageData = reply.JSON["image"].(map[string]interface{})
	if !strings.Contains(imageData["error"].(string), "unsupported") {
		t.Fatalf("expected unsupported error, got %v", imageData["error"])
	}
}

// contract: images.envelope.ignores-body-without-image, images.envelope.ignores-invalid-json
func TestNonImageBodyIsNotHandled(t *testing.T) {
	images := host.NewImages()

	// The case without an image field
	bodyNoImage := map[string]any{
		"other": "data",
	}
	bodyBytes, _ := json.Marshal(bodyNoImage)

	decision := host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	_, ok := decision.(*host.NotImage)
	if !ok {
		t.Fatalf("expected NotImage for body without image field, got %T", decision)
	}

	// Invalid JSON
	decision = host.Decide([]byte("not json"), "sidecar-a", "tab-1", images)
	_, ok = decision.(*host.NotImage)
	if !ok {
		t.Fatalf("expected NotImage for invalid JSON, got %T", decision)
	}
}

// contract: images.envelope.refusal-preserves-quoted-name
func TestReplyEscapesNames(t *testing.T) {
	images := host.NewImages()
	nonce := "AAAAAAAAAAAAAAAAAAAAAA==" // 16 zero bytes
	body := map[string]any{
		"image": map[string]any{
			"name": "a\"b",
			"token": map[string]any{
				"kind":  "iosurface-global",
				"id":    uint32(12345),
				"nonce": nonce,
			},
			"width":      800,
			"height":     600,
			"scale":      2.0,
			"format":     "bgra8",
			"generation": uint64(1),
			"raster":     uint64(1),
			"sequence":   1,
		},
	}
	bodyBytes, _ := json.Marshal(body)

	// The image is not registered, so Reply must be returned
	decision := host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	reply, ok := decision.(*host.Reply)
	if !ok {
		t.Fatalf("expected Reply, got %T", decision)
	}

	// Converts the reply to JSON to check validity
	responseBytes, err := json.Marshal(reply.JSON)
	if err != nil {
		t.Fatalf("failed to marshal response: %v", err)
	}
	if err := json.Unmarshal(responseBytes, &map[string]any{}); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}

	// Checks that the name is escaped correctly
	imageData := reply.JSON["image"].(map[string]interface{})
	if imageData["name"] != "a\"b" {
		t.Fatalf("expected name a\"b, got %v", imageData["name"])
	}
}

// contract: images.attach.surface-close-removes-only-its-images
func TestSurfaceCloseRemovesOnlyItsImages(t *testing.T) {
	images := host.NewImages()

	var a, b, c int
	key1 := host.ImageKey{Surface: "tab-1", Name: "view"}
	key2 := host.ImageKey{Surface: "tab-1", Name: "other"}
	key3 := host.ImageKey{Surface: "tab-2", Name: "view"}

	owner := &host.ImageOwner{SidecarName: "sidecar", SidecarOwner: newFakeImageOwner("")}

	// Registers 2 images in tab-1
	if err := images.Reserve(key1, owner); err != nil {
		t.Fatal(err)
	}
	images.Set(key1, unsafe.Pointer(&a))

	if err := images.Reserve(key2, owner); err != nil {
		t.Fatal(err)
	}
	images.Set(key2, unsafe.Pointer(&b))

	// Registers 1 image in tab-2
	if err := images.Reserve(key3, owner); err != nil {
		t.Fatal(err)
	}
	images.Set(key3, unsafe.Pointer(&c))

	// Removes all images of the tab-1 surface
	removed := images.RemoveSurface("tab-1")
	if len(removed) != 2 {
		t.Fatalf("expected 2 removed images, got %d", len(removed))
	}

	// Checks the removed image handles
	removedPtrs := map[unsafe.Pointer]bool{}
	for _, ptr := range removed {
		removedPtrs[ptr] = true
	}
	if !removedPtrs[unsafe.Pointer(&a)] || !removedPtrs[unsafe.Pointer(&b)] {
		t.Fatalf("wrong handles removed")
	}

	// The images of tab-1 are no longer accessible
	if _, err := images.Get(key1); err == nil {
		t.Fatal("tab-1 image1 should not exist after removal")
	}
	if _, err := images.Get(key2); err == nil {
		t.Fatal("tab-1 image2 should not exist after removal")
	}

	// The images of tab-2 are still accessible
	if got, err := images.Get(key3); err != nil || got != unsafe.Pointer(&c) {
		t.Fatalf("tab-2 image should still exist: %v", err)
	}
}

// contract: images.attach.rejects-reservation-without-sidecar
func TestReserveRejectsNilOwner(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}

	// Tries reserve with a nil owner
	err := images.Reserve(key, nil)
	if err == nil {
		t.Fatal("expected error for nil owner, got nil")
	}
	if !strings.Contains(err.Error(), "owner is required") {
		t.Fatalf("expected 'owner is required' error, got %v", err)
	}

	// Checks that no image was registered
	if _, err := images.Get(key); err == nil {
		t.Fatal("image should not be registered after failed reserve")
	}
}

// contract: images.envelope.presents-attached-current-frame
func TestEnvelopeFromTheAttachedSidecarIsPresented(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}

	var a int
	// The images that a specific sidecar attached
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	if err := images.Reserve(key, owner); err != nil {
		t.Fatalf("reserve failed: %v", err)
	}
	images.Set(key, unsafe.Pointer(&a))
	configureImage(t, images, key, 800, 600, 2.0)

	nonce := "AAAAAAAAAAAAAAAAAAAAAA=="
	body := map[string]any{
		"image": map[string]any{
			"name": "view",
			"token": map[string]any{
				"kind":  "iosurface-global",
				"id":    uint32(12345),
				"nonce": nonce,
			},
			"width":      800,
			"height":     600,
			"scale":      2.0,
			"format":     "bgra8",
			"generation": uint64(1),
			"raster":     uint64(1),
			"sequence":   1,
		},
	}
	bodyBytes, _ := json.Marshal(body)

	// When the same sidecar sends the same image, it must return Present
	decision := host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	present, ok := decision.(*host.Present)
	if !ok {
		t.Fatalf("expected Present, got %T", decision)
	}
	if present.Name != "view" {
		t.Fatalf("expected name view, got %s", present.Name)
	}
}

// contract: images.envelope.rejects-other-sidecar
func TestEnvelopeFromAnotherSidecarIsRefused(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}
	attachImage(t, images, key)
	// This is the configured current raster, so the only reason for rejection is the sidecar that sent it.
	configured := configureImage(t, images, key, 800, 600, 2.0)
	envelope := configuredEnvelope(t, configured, 1)
	reply, ok := host.Decide(envelope, "sidecar-b", key.Surface, images).(*host.Reply)
	if !ok {
		t.Fatal("an envelope from another sidecar was not refused")
	}
	if image := reply.JSON["image"].(map[string]interface{}); image["error"] != "notAttached" {
		t.Fatalf("another sidecar was answered %v, want notAttached", image)
	}
	// Contrast: the same envelope that the connected sidecar sent is displayed.
	if _, ok := host.Decide(envelope, "sidecar-a", key.Surface, images).(*host.Present); !ok {
		t.Fatal("the attaching sidecar's envelope for the configured raster was not presented")
	}
}

// contract: images.present.main-thread-failure-reports-present-failed
func TestPresentationFailureIsReported(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}

	var a int
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	if err := images.Reserve(key, owner); err != nil {
		t.Fatalf("reserve failed: %v", err)
	}
	images.Set(key, unsafe.Pointer(&a))
	configureImage(t, images, key, 800, 600, 2.0)

	nonce := "AAAAAAAAAAAAAAAAAAAAAA=="
	body := map[string]any{
		"image": map[string]any{
			"name": "view",
			"token": map[string]any{
				"kind":  "iosurface-global",
				"id":    uint32(12345),
				"nonce": nonce,
			},
			"width":      800,
			"height":     600,
			"scale":      2.0,
			"format":     "bgra8",
			"generation": uint64(1),
			"raster":     uint64(1),
			"sequence":   1,
		},
	}
	bodyBytes, _ := json.Marshal(body)

	// Sets the fake onMain to return false
	var receivedImageName string
	var receivedResponse map[string]interface{}
	handled := host.HandleEnvelope(bodyBytes, "sidecar-a", "tab-1", images,
		func(func() error) error {
			// This is a presentation failure in which the main thread task could not run.
			return errors.New("main thread unavailable")
		},
		func(imageName string, response map[string]interface{}) error {
			receivedImageName = imageName
			receivedResponse = response
			return nil
		},
		func(reason string) error {
			if reason != "presentFailed" {
				t.Errorf("recovery reason %q, want presentFailed", reason)
			}
			return nil
		},
		func() bool { return true },
	)

	if !handled {
		t.Fatal("envelope should have been handled")
	}

	if receivedImageName != "view" {
		t.Fatalf("expected image name 'view', got %q", receivedImageName)
	}

	if receivedResponse == nil {
		t.Fatal("expected response, got nil")
	}

	imageObj, ok := receivedResponse["image"]
	if !ok {
		t.Fatal("expected image key in response")
	}

	imageData, ok := imageObj.(map[string]interface{})
	if !ok {
		t.Fatalf("expected image data to be map, got %T", imageObj)
	}

	if imageData["error"] != "presentFailed" {
		t.Fatalf("expected error presentFailed, got %v", imageData["error"])
	}
	if imageData["name"] != "view" {
		t.Fatalf("expected name view, got %v", imageData["name"])
	}
	seq := imageData["sequence"]
	var seqVal int
	switch v := seq.(type) {
	case int:
		seqVal = v
	case float64:
		seqVal = int(v)
	default:
		t.Fatalf("unexpected sequence type %T", seq)
	}
	if seqVal != 1 {
		t.Fatalf("expected sequence 1, got %v", seqVal)
	}
	if err := images.WaitCurrentError(0); err == nil || err.Error() != "presentFailed" {
		t.Fatalf("expected native presentation failure, got %v", err)
	}
}

// attachImage connects the image region of the sidecar sidecar-a to key.
func attachImage(t *testing.T, images *host.Images, key host.ImageKey) {
	t.Helper()
	var handle int
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach %v: %v", key, err)
	}
}

// noRecovery records a recovery call as a failure in cases that must have no presentation failure.
func noRecovery(t *testing.T) func(string) error {
	return func(reason string) error {
		t.Errorf("unexpected recovery for %q", reason)
		return nil
	}
}

// contract: images.transfer.new-generation-invalidates-queued-old-frame
func TestBeginningANewGenerationInvalidatesAQueuedOldFrame(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-queued", Name: "view"}
	firstGeneration := images.BeginGeneration(key.Surface)
	attachImage(t, images, key)
	first := configureImage(t, images, key, 800, 600, 2.0)
	if first.Generation != firstGeneration {
		t.Fatalf("configured generation %d, want %d", first.Generation, firstGeneration)
	}
	if _, ok := host.Decide(configuredEnvelope(t, first, 1), "sidecar-a", key.Surface, images).(*host.Present); !ok {
		t.Fatal("the current frame was rejected")
	}
	if next := images.BeginGeneration(key.Surface); next <= firstGeneration {
		t.Fatalf("next generation %d is not after %d", next, firstGeneration)
	}
	reply, ok := host.Decide(configuredEnvelope(t, first, 2), "sidecar-a", key.Surface, images).(*host.Reply)
	if !ok {
		t.Fatal("a queued frame of the old generation was not invalidated")
	}
	if image := reply.JSON["image"].(map[string]interface{}); image["error"] != "notAttached" {
		t.Fatalf("old generation frame answered %v, want notAttached", image)
	}
}

// contract: images.present.rejects-frame-detached-during-main-thread
func TestFrameDetachedBeforeMainThreadPresentationIsReportedAsStale(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}
	attachImage(t, images, key)
	first := configureImage(t, images, key, 800, 600, 2.0)
	var response map[string]interface{}
	host.HandleEnvelope(configuredEnvelope(t, first, 1), "sidecar-a", key.Surface, images,
		func(work func() error) error {
			images.RemoveSurface(key.Surface)
			return work()
		},
		func(_ string, value map[string]interface{}) error {
			response = value
			return nil
		},
		noRecovery(t),
		func() bool { return true },
	)
	if image, _ := response["image"].(map[string]interface{}); image == nil || image["error"] != "stale" {
		t.Fatalf("detached frame answered %v, want stale", response)
	}
}

// contract: images.present.missing-native-surface-requests-reconfiguration
func TestMissingNativeSurfaceRequestsAFreshRasterConfiguration(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}
	attachImage(t, images, key)
	first := configureImage(t, images, key, 800, 600, 2.0)
	var recovered *host.ImageConfigure
	host.HandleEnvelope(configuredEnvelope(t, first, 1), "sidecar-a", key.Surface, images,
		func(func() error) error { return errors.New("notFound") },
		func(string, map[string]interface{}) error { return nil },
		func(reason string) error {
			if reason != "notFound" {
				t.Errorf("recovery reason %q, want notFound", reason)
			}
			next, err := images.ConfigureRaster(key, 800, 600, 2.0, true)
			recovered = next
			return err
		},
		func() bool { return true },
	)
	if recovered == nil || recovered.Raster != first.Raster {
		t.Fatalf("recovery configuration %+v, want raster %d again", recovered, first.Raster)
	}
	if images.CurrentPresented() {
		t.Fatal("the failed raster is reported as presented")
	}
}

// contract: images.invalidate.sidecar-connection-loss-resends-configure
func TestInvalidatingASidecarResendsItsConfigureAndLeavesOtherSidecars(t *testing.T) {
	images := host.NewImages()
	terminal := host.ImageKey{Surface: "tab-1", Name: "view"}
	browser := host.ImageKey{Surface: "tab-2", Name: "view"}
	var a, b int
	if err := images.Reserve(terminal, &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}); err != nil {
		t.Fatalf("reserve terminal failed: %v", err)
	}
	images.Set(terminal, unsafe.Pointer(&a))
	if err := images.Reserve(browser, &host.ImageOwner{SidecarName: "sidecar-b", SidecarOwner: newFakeImageOwner("")}); err != nil {
		t.Fatalf("reserve browser failed: %v", err)
	}
	images.Set(browser, unsafe.Pointer(&b))
	configureImage(t, images, terminal, 800, 600, 2.0)
	configureImage(t, images, browser, 800, 600, 2.0)
	// A reconfiguration of the same size is not sent, because the state is already configured.
	if configuration, err := images.ConfigureRaster(terminal, 800, 600, 2.0, true); err != nil || configuration != nil {
		t.Fatalf("same-size reconfigure sent again: %v %v", configuration, err)
	}

	// Invalidates only the configure state of the sidecar whose connection was lost (V5-106).
	if invalidated := images.InvalidateSidecar("sidecar-a"); invalidated != 1 {
		t.Fatalf("exactly sidecar-a's images are invalidated, got %d", invalidated)
	}
	if invalidated := images.InvalidateSidecar("sidecar-c"); invalidated != 0 {
		t.Fatalf("an unknown sidecar invalidates nothing, got %d", invalidated)
	}

	// A configuration of the same size for the invalidated sidecar is sent again, because the service of the new connection has no picture state.
	resent, err := images.ConfigureRaster(terminal, 800, 600, 2.0, true)
	if err != nil || resent == nil {
		t.Fatalf("the invalidated sidecar's configure was not resent at the same size: %v %v", resent, err)
	}
	if resent.Sidecar != "sidecar-a" {
		t.Fatalf("the resent configure belongs to %q", resent.Sidecar)
	}

	// The regions of another sidecar were not invalidated, so a reconfiguration of the same size is still not sent.
	if configuration, err := images.ConfigureRaster(browser, 800, 600, 2.0, true); err != nil || configuration != nil {
		t.Fatalf("the other sidecar's same-size reconfigure sent again: %v %v", configuration, err)
	}
}

// contract: images.visibility.shown-surface-reconfigures-its-raster
func TestShownSurfaceReconfiguresItsRaster(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "returning", Name: "view"}
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	var handle int
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach image: %v", err)
	}
	first := configureImage(t, images, key, 800, 600, 2)
	// A frame received while hidden is not displayed because the native layer was released. When it is shown again, a new raster must be
	// set even for the same size, and the raster of the hidden period is not waited for.
	images.SetSurfaceVisible(key.Surface, false)
	images.SetSurfaceVisible(key.Surface, true)
	shown, err := images.ConfigureRaster(key, 800, 600, 2, true)
	if err != nil || shown == nil {
		t.Fatalf("the shown surface did not configure a raster: %+v %v", shown, err)
	}
	if shown.Raster <= first.Raster {
		t.Fatalf("the shown surface reused raster %d after %d", shown.Raster, first.Raster)
	}
}

// contract: images.present.replaced-frame-is-logged-as-invalidated
func TestPresentationOutcomeLogsAReplacedFrameAsInvalidated(t *testing.T) {
	for _, detail := range []string{"stale", "notAttached", "staleRaster native=1520x573@2 frame=760x192@2", "staleRaster native=none"} {
		reason, invalidated, entry := host.PresentationOutcome("s1", "view", 3, 2, 1, 9, detail, "unused")
		line := entry.Line()
		want := "info host image present: frame invalidated before native presentation: surface=s1 name=view generation=3 raster=2 sequence=1 token=9 reason=" + detail
		if reason != "stale" || !invalidated || line != want {
			t.Fatalf("%s: reason %q invalidated %v line %q", detail, reason, invalidated, line)
		}
	}
}

// contract: images.present.failure-line-names-the-current-frame
func TestPresentationOutcomeNamesTheCurrentFrameOfAFailure(t *testing.T) {
	for detail, want := range map[string]string{"notFound": "notFound", "presentFailed": "presentFailed", "boom": "presentFailed"} {
		reason, invalidated, entry := host.PresentationOutcome("s1", "view", 3, 2, 1, 9, detail, "generation=3 raster=2")
		line := entry.Line()
		wantLine := "error host image present: surface=s1 name=view generation=3 raster=2 sequence=1 token=9 reason=" + detail + " current generation=3 raster=2"
		if reason != want || invalidated || line != wantLine {
			t.Fatalf("%s: reason %q invalidated %v line %q", detail, reason, invalidated, line)
		}
	}
}

// When an image region is detached from the same surface document and attached again, the generation stays the same, so the raster of the attached region must be larger than the raster the sidecar already
// received. The sidecar ignores a configuration whose (generation, raster) did not increase as a past configuration.
// contract: images.transfer.reattach-continues-raster
func TestReattachingInTheSameGenerationContinuesTheRaster(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	var handle int
	images.BeginGeneration(key.Surface)
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach image: %v", err)
	}
	configureImage(t, images, key, 800, 600, 2.0)
	before := configureImage(t, images, key, 900, 600, 2.0)
	if _, err := images.Remove(key); err != nil {
		t.Fatal(err)
	}
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach image again: %v", err)
	}
	after := configureImage(t, images, key, 700, 600, 2.0)
	if after.Generation != before.Generation || after.Raster <= before.Raster {
		t.Fatalf("configuration after reattaching is (%d, %d), want generation %d and a raster above %d",
			after.Generation, after.Raster, before.Generation, before.Raster)
	}
	// It is the same after all regions of the surface are detached.
	images.RemoveSurface(key.Surface)
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach image after removing the surface regions: %v", err)
	}
	again := configureImage(t, images, key, 800, 600, 2.0)
	if again.Generation != after.Generation || again.Raster <= after.Raster {
		t.Fatalf("configuration after removing the surface regions is (%d, %d), want generation %d and a raster above %d",
			again.Generation, again.Raster, after.Generation, after.Raster)
	}
}

// ImageCaret and ImageText of a surface page send the coordinates and the text together after the request. The arguments are decoded as listed, and
// the call must fail at the next step, the caller check (G1.4-109).
// contract: host-calls.native.image-argument-lists
func TestNativeImageCallsDecodeTheirOwnArguments(t *testing.T) {
	surfaces := host.NewSurfaces(nil, nil)
	request := json.RawMessage(`{"surface":"tab-1","name":"view"}`)
	number := func(value string) json.RawMessage { return json.RawMessage(value) }
	for method, args := range map[string][]json.RawMessage{
		"ImageCaret": {request, number("1"), number("2"), number("3"), number("4")},
		"ImageText":  {request, json.RawMessage(`"text"`)},
	} {
		want := map[string]string{"ImageCaret": "imageCaret", "ImageText": "imageText"}[method] + ": window is not available"
		if _, err := host.InvokeNative(surfaces, 7, method, args); err == nil || err.Error() != want {
			t.Errorf("%s: %v, want the caller check to fail with %s", method, err, want)
		}
	}
}

// The failure of an image region call names the call (G1.4-112).
// contract: images.calls.name-the-call
func TestImageCallFailuresNameTheCall(t *testing.T) {
	if err := host.ImageCallError("imageDetach", errors.New(`image "view" is not attached`)); err == nil ||
		err.Error() != `imageDetach: image "view" is not attached` {
		t.Fatalf("named error: %v", err)
	}
	if err := host.ImageCallError("imageDetach", nil); err != nil {
		t.Fatalf("a successful call failed: %v", err)
	}
	surfaces := host.NewSurfaces(nil, nil)
	request := json.RawMessage(`{"surface":"tab-1","name":"view","sidecar":"@fixture/sidecar-echo"}`)
	for method, call := range map[string]string{"ImageAttach": "imageAttach", "ImageFocus": "imageFocus", "ImageDetach": "imageDetach"} {
		if _, err := host.InvokeNative(surfaces, 7, method, []json.RawMessage{request}); err == nil || err.Error() != call+": window is not available" {
			t.Errorf("%s: %v, want %s: window is not available", method, err, call)
		}
	}
}

// A frame that the host refuses, and an envelope that is not valid, leave a record with the frame and the current state
// of the region.
// contract: images.envelope.refusal-is-recorded
func TestImageFrameRefusalsAreRecorded(t *testing.T) {
	written := captureLog(t)
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}
	attachImage(t, images, key)
	configured := configureImage(t, images, key, 800, 600, 2.0)
	send := func(string, map[string]interface{}) error { return nil }
	onMain := func(run func() error) error { return run() }
	recoverFrame := func(string) error { return nil }

	// A sidecar that does not own the region.
	host.HandleEnvelope(configuredEnvelope(t, configured, 1), "sidecar-b", key.Surface, images, onMain, send, recoverFrame, func() bool { return true })
	// A format that the host does not present.
	var unsupported map[string]any
	if err := json.Unmarshal(configuredEnvelope(t, configured, 2), &unsupported); err != nil {
		t.Fatal(err)
	}
	unsupported["image"].(map[string]any)["format"] = "rgba8"
	body, _ := json.Marshal(unsupported)
	host.HandleEnvelope(body, "sidecar-a", key.Surface, images, onMain, send, recoverFrame, func() bool { return true })
	// An image field that is not an envelope is not handled as an image, and the record shows it.
	if host.HandleEnvelope([]byte(`{"image":{"name":5}}`), "sidecar-a", key.Surface, images, onMain, send, recoverFrame, func() bool { return true }) {
		t.Fatal("a malformed envelope was handled as an image")
	}

	log := written()
	frame := "generation=" + strconv.FormatUint(configured.Generation, 10) + " raster=" + strconv.FormatUint(configured.Raster, 10)
	for _, want := range []string{
		" info host image frame: surface=tab-1 name=view sender=sidecar-b " + frame + " sequence=1 refused: notAttached current generation=",
		" error host image frame: surface=tab-1 name=view sender=sidecar-a " + frame + " sequence=2 refused: unsupported current generation=",
		` error host image frame: surface=tab-1 sender=sidecar-a malformed image envelope: {"name":5}`,
	} {
		if !strings.Contains(log, want) {
			t.Fatalf("the log has no %q:\n%s", want, log)
		}
	}
}

// contract: exposure.window.region-reports-presented-frame
func TestPresentedFrameIdentityIsReported(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	var handle int

	images.BeginGeneration(key.Surface)
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach image: %v", err)
	}
	if frame, ok := images.PresentedFrame(key); ok {
		t.Fatalf("an image without a presented frame reports %+v", frame)
	}
	raster := configureImage(t, images, key, 800, 600, 2.0)
	if _, ok := host.Decide(configuredEnvelope(t, raster, 2), "sidecar-a", key.Surface, images).(*host.Present); !ok {
		t.Fatal("current frame was rejected")
	}
	images.MarkPresented(key, raster.Generation, raster.Raster, 2)
	frame, ok := images.PresentedFrame(key)
	if !ok || frame.Generation != raster.Generation || frame.Raster != raster.Raster || frame.Sequence != 2 {
		t.Fatalf("presented frame is %+v (present %t), want generation %d, raster %d, sequence 2",
			frame, ok, raster.Generation, raster.Raster)
	}
	// A newer frame that the host accepted and has not presented leaves the presented frame as it was.
	if _, ok := host.Decide(configuredEnvelope(t, raster, 3), "sidecar-a", key.Surface, images).(*host.Present); !ok {
		t.Fatal("newer frame was rejected")
	}
	if frame, ok := images.PresentedFrame(key); !ok || frame.Sequence != 2 {
		t.Fatalf("presented frame with a newer frame pending is %+v (present %t), want sequence 2", frame, ok)
	}
	configureImage(t, images, key, 900, 600, 2.0)
	if frame, ok := images.PresentedFrame(key); ok {
		t.Fatalf("presented frame %+v survives a raster change", frame)
	}
}

// contract: trace.image-frame-answer-is-recorded
func TestFrameAnswerEventRecordsConsumedAndRefusedAnswers(t *testing.T) {
	answers := []struct {
		name     string
		response map[string]interface{}
	}{
		{"consumed", host.AfterPresent(true, "", "view", 1, 1, 7)},
		{"refused", host.AfterPresent(false, "notAttached", "view", 1, 1, 8)},
	}
	for _, answer := range answers {
		event := host.FrameAnswerEvent("tab-1", "view", answer.response)
		if got := event["event"]; got != "image.frame" {
			t.Fatalf("%s answer: event %v, want image.frame", answer.name, got)
		}
		if got := event["surface"]; got != "tab-1" {
			t.Fatalf("%s answer: surface %v, want tab-1", answer.name, got)
		}
		if got := event["name"]; got != "view" {
			t.Fatalf("%s answer: name %v, want view", answer.name, got)
		}
		if got, ok := event["response"].(map[string]interface{}); !ok || !reflect.DeepEqual(got, answer.response) {
			t.Fatalf("%s answer: response %v, want %v", answer.name, event["response"], answer.response)
		}
		if len(event) != 4 {
			t.Fatalf("%s answer: event has %d fields, want event, surface, name and response", answer.name, len(event))
		}
	}
}

// A frame of a sidecar that no plugin declares, such as the frame in flight when a plugin is removed while its card is
// open, belongs to a process that ended: its failure invalidates the frame without recovery, and an answer that cannot
// reach the ended sidecar is recorded.
// contract: images.present.frame-of-undeclared-sidecar-is-invalidated
func TestAFrameOfASidecarThatNoPluginDeclaresIsInvalidated(t *testing.T) {
	written := captureLog(t)
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}
	attachImage(t, images, key)
	first := configureImage(t, images, key, 800, 600, 2.0)
	var answers []map[string]interface{}
	host.HandleEnvelope(configuredEnvelope(t, first, 1), "sidecar-a", key.Surface, images,
		func(func() error) error { return errors.New("notFound") },
		func(_ string, response map[string]interface{}) error {
			answers = append(answers, response)
			return fmt.Errorf("answer: %w", host.ErrSidecarEnded)
		},
		func(reason string) error {
			t.Errorf("recovery of %q was requested for a sidecar that no plugin declares", reason)
			return nil
		},
		func() bool { return false },
	)
	if len(answers) != 1 || answers[0]["image"].(map[string]interface{})["error"] != "stale" {
		t.Fatalf("answers %+v, want one stale answer", answers)
	}
	if strings.Contains(written(), " error ") {
		t.Fatalf("an ended sidecar produced an error line:\n%s", written())
	}
}
