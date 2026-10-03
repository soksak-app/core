package host_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
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

// declareImages 는 directory 에 설치된 사이드카 하나의 선언이다.
func declareImages(directory, sidecar string) []host.SidecarDeclaration {
	return []host.SidecarDeclaration{{Name: imageSidecar, Folder: directory, Data: []byte(sidecar)}}
}

// fakeImageOwner 는 받은 사이드카 이벤트를 기록하는 창이다.
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

// echoSidecarsForImages 는 받은 줄을 그대로 출력하는 fake 사이드카를 선언한 채널을 만든다.
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
	nonce := "AAAAAAAAAAAAAAAAAAAAAA==" // 0 바이트 16개
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

	// 이미지가 등록되지 않았으므로 notAttached 오류를 반환해야 함
	decision := host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	reply, ok := decision.(*host.Reply)
	if !ok {
		t.Fatalf("expected Reply(notAttached), got %T", decision)
	}
	imageData := reply.JSON["image"].(map[string]interface{})
	if !strings.Contains(imageData["error"].(string), "notAttached") {
		t.Fatalf("expected notAttached error, got %v", imageData["error"])
	}
	// 거절 응답은 봉투의 이름과 순번을 그대로 돌려준다.
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

	// 다른 사이드카가 같은 이미지를 보내면 notAttached 오류를 반환해야 함
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

	// 0부터 15까지의 16바이트다. 0이 아닌 값이어야 nonce 복사를 구별할 수 있다.
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

	// 같은 사이드카가 같은 이미지를 보내면 Present를 반환해야 함
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
	// 메인 스레드 표시가 성공한 것으로 응답하는 onMain 으로 봉투를 처리한다.
	var response map[string]interface{}
	if !host.HandleEnvelope(configuredEnvelope(t, first, 1), "sidecar-a", key.Surface, images,
		func(func() error) error { return nil },
		func(_ string, value map[string]interface{}) error {
			response = value
			return nil
		},
		noRecovery(t),
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

	// 포맷이 잘못된 경우
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
			"format":     "rgba8", // 잘못된 포맷
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

	// nonce 길이가 잘못된 경우
	bodyWrongNonce := map[string]any{
		"image": map[string]any{
			"name": "view",
			"token": map[string]any{
				"kind":  "iosurface-global",
				"id":    uint32(12345),
				"nonce": "short", // 16바이트가 아님
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

	// token.kind이 잘못된 경우
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

	// 이미지 필드가 없는 경우
	bodyNoImage := map[string]any{
		"other": "data",
	}
	bodyBytes, _ := json.Marshal(bodyNoImage)

	decision := host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	_, ok := decision.(*host.NotImage)
	if !ok {
		t.Fatalf("expected NotImage for body without image field, got %T", decision)
	}

	// 잘못된 JSON
	decision = host.Decide([]byte("not json"), "sidecar-a", "tab-1", images)
	_, ok = decision.(*host.NotImage)
	if !ok {
		t.Fatalf("expected NotImage for invalid JSON, got %T", decision)
	}
}

// contract: images.envelope.refusal-preserves-quoted-name
func TestReplyEscapesNames(t *testing.T) {
	images := host.NewImages()
	nonce := "AAAAAAAAAAAAAAAAAAAAAA==" // 0 바이트 16개
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

	// 등록되지 않은 이미지이므로 Reply가 반환되어야 함
	decision := host.Decide(bodyBytes, "sidecar-a", "tab-1", images)
	reply, ok := decision.(*host.Reply)
	if !ok {
		t.Fatalf("expected Reply, got %T", decision)
	}

	// 응답을 JSON으로 변환하여 유효성 확인
	responseBytes, err := json.Marshal(reply.JSON)
	if err != nil {
		t.Fatalf("failed to marshal response: %v", err)
	}
	if err := json.Unmarshal(responseBytes, &map[string]any{}); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}

	// 이름이 올바르게 이스케이프되었는지 확인
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

	// tab-1에 2개 이미지 등록
	if err := images.Reserve(key1, owner); err != nil {
		t.Fatal(err)
	}
	images.Set(key1, unsafe.Pointer(&a))

	if err := images.Reserve(key2, owner); err != nil {
		t.Fatal(err)
	}
	images.Set(key2, unsafe.Pointer(&b))

	// tab-2에 1개 이미지 등록
	if err := images.Reserve(key3, owner); err != nil {
		t.Fatal(err)
	}
	images.Set(key3, unsafe.Pointer(&c))

	// tab-1 표면의 모든 이미지 제거
	removed := images.RemoveSurface("tab-1")
	if len(removed) != 2 {
		t.Fatalf("expected 2 removed images, got %d", len(removed))
	}

	// 제거된 이미지 핸들 확인
	removedPtrs := map[unsafe.Pointer]bool{}
	for _, ptr := range removed {
		removedPtrs[ptr] = true
	}
	if !removedPtrs[unsafe.Pointer(&a)] || !removedPtrs[unsafe.Pointer(&b)] {
		t.Fatalf("wrong handles removed")
	}

	// tab-1의 이미지는 더 이상 접근 불가
	if _, err := images.Get(key1); err == nil {
		t.Fatal("tab-1 image1 should not exist after removal")
	}
	if _, err := images.Get(key2); err == nil {
		t.Fatal("tab-1 image2 should not exist after removal")
	}

	// tab-2의 이미지는 여전히 접근 가능
	if got, err := images.Get(key3); err != nil || got != unsafe.Pointer(&c) {
		t.Fatalf("tab-2 image should still exist: %v", err)
	}
}

// contract: images.attach.rejects-reservation-without-sidecar
func TestReserveRejectsNilOwner(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}

	// nil owner로 reserve 시도
	err := images.Reserve(key, nil)
	if err == nil {
		t.Fatal("expected error for nil owner, got nil")
	}
	if !strings.Contains(err.Error(), "owner is required") {
		t.Fatalf("expected 'owner is required' error, got %v", err)
	}

	// 이미지가 등록되지 않았는지 확인
	if _, err := images.Get(key); err == nil {
		t.Fatal("image should not be registered after failed reserve")
	}
}

// contract: images.envelope.presents-attached-current-frame
func TestEnvelopeFromTheAttachedSidecarIsPresented(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}

	var a int
	// 특정 사이드카가 attachment 한 이미지
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

	// 같은 사이드카가 같은 이미지를 보내면 Present를 반환해야 함
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
	// 구성된 현재 래스터이므로 거부 이유는 보낸 사이드카뿐이다.
	configured := configureImage(t, images, key, 800, 600, 2.0)
	envelope := configuredEnvelope(t, configured, 1)
	reply, ok := host.Decide(envelope, "sidecar-b", key.Surface, images).(*host.Reply)
	if !ok {
		t.Fatal("an envelope from another sidecar was not refused")
	}
	if image := reply.JSON["image"].(map[string]interface{}); image["error"] != "notAttached" {
		t.Fatalf("another sidecar was answered %v, want notAttached", image)
	}
	// 대조: 연결한 사이드카가 보낸 같은 봉투는 표시된다.
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

	// 가짜 onMain 이 false 를 반환하도록 설정
	var receivedImageName string
	var receivedResponse map[string]interface{}
	handled := host.HandleEnvelope(bodyBytes, "sidecar-a", "tab-1", images,
		func(func() error) error {
			// 메인 스레드 작업을 실행하지 못한 표시 실패다.
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

// attachImage 는 사이드카 sidecar-a 의 그림 영역을 key 에 연결한다.
func attachImage(t *testing.T, images *host.Images, key host.ImageKey) {
	t.Helper()
	var handle int
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	if err := images.Reserve(key, owner); err != nil || !images.Set(key, unsafe.Pointer(&handle)) {
		t.Fatalf("attach %v: %v", key, err)
	}
}

// noRecovery 는 표시 실패가 없어야 하는 사례에서 복구 호출을 실패로 기록한다.
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
	// 같은 크기의 재구성은 전송하지 않는다 — 상태가 이미 구성되었기 때문이다.
	if configuration, err := images.ConfigureRaster(terminal, 800, 600, 2.0, true); err != nil || configuration != nil {
		t.Fatalf("same-size reconfigure sent again: %v %v", configuration, err)
	}

	// 연결이 끊긴 사이드카의 configure 상태만 무효화한다(V5-106).
	if invalidated := images.InvalidateSidecar("sidecar-a"); invalidated != 1 {
		t.Fatalf("exactly sidecar-a's images are invalidated, got %d", invalidated)
	}
	if invalidated := images.InvalidateSidecar("sidecar-c"); invalidated != 0 {
		t.Fatalf("an unknown sidecar invalidates nothing, got %d", invalidated)
	}

	// 무효화된 사이드카의 같은 크기 구성은 다시 전송된다 — 새 연결의 서비스는 그림 상태가 없다.
	resent, err := images.ConfigureRaster(terminal, 800, 600, 2.0, true)
	if err != nil || resent == nil {
		t.Fatalf("the invalidated sidecar's configure was not resent at the same size: %v %v", resent, err)
	}
	if resent.Sidecar != "sidecar-a" {
		t.Fatalf("the resent configure belongs to %q", resent.Sidecar)
	}

	// 다른 사이드카의 영역은 무효화되지 않았으므로 같은 크기 재구성은 여전히 전송하지 않는다.
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
	// 숨긴 동안 받은 frame 은 native layer 가 해제되어 표시되지 않는다. 다시 보이면 같은 크기라도 새 raster 를
	// 설정해야 하며, 숨긴 동안의 raster 를 기다리지 않는다.
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
		reason, invalidated, line := host.PresentationOutcome("s1", "view", 3, 2, 1, 9, detail, "unused")
		want := "image frame invalidated before native presentation: surface=s1 name=view generation=3 raster=2 sequence=1 token=9 reason=" + detail
		if reason != "stale" || !invalidated || line != want {
			t.Fatalf("%s: reason %q invalidated %v line %q", detail, reason, invalidated, line)
		}
	}
}

// contract: images.present.failure-line-names-the-current-frame
func TestPresentationOutcomeNamesTheCurrentFrameOfAFailure(t *testing.T) {
	for detail, want := range map[string]string{"notFound": "notFound", "presentFailed": "presentFailed", "boom": "presentFailed"} {
		reason, invalidated, line := host.PresentationOutcome("s1", "view", 3, 2, 1, 9, detail, "generation=3 raster=2")
		wantLine := "image present on main thread error: surface=s1 name=view generation=3 raster=2 sequence=1 token=9 reason=" + detail + " current generation=3 raster=2"
		if reason != want || invalidated || line != wantLine {
			t.Fatalf("%s: reason %q invalidated %v line %q", detail, reason, invalidated, line)
		}
	}
}

// 같은 표면 문서에서 그림 영역을 떼었다가 다시 붙이면 세대가 그대로이므로, 다시 붙인 영역의 래스터는 사이드카가 이미
// 받은 래스터보다 커야 한다. 사이드카는 (세대, 래스터)가 커지지 않은 구성을 지난 구성으로 보고 무시한다.
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
	// 표면의 모든 영역을 뗀 뒤에도 같다.
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
