package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
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

// frontendForImages 는 플러그인 하나와 그 플러그인이 의존하는 사이드카 하나를 선언한 스테이징 결과다.
func frontendForImages(sidecar string) fstest.MapFS {
	return fstest.MapFS{
		"environment.json":                          {Data: []byte(`{"plugins":["@fixture/plugin"]}`)},
		"modules/@fixture/plugin/plugin.json":       {Data: []byte(`{"id":"plugin","sidecars":["` + imageSidecar + `"]}`)},
		"modules/" + imageSidecar + "/sidecar.json": {Data: []byte(sidecar)},
	}
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
	case <-time.After(10 * time.Second):
		t.Fatal("no sidecar event within 10s")
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
	sidecars, err := host.NewSidecars(frontendForImages(`{"executable":"build/echo","protocol":1}`), directory, directory)
	if err != nil {
		t.Fatal(err)
	}
	return sidecars, record
}

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
}

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

func TestAttachedImageIsPresented(t *testing.T) {
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
}

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
	if _, ok := host.Decide(configuredEnvelope(t, first, 1), "sidecar-a", key.Surface, images).(*host.Present); !ok {
		t.Fatal("current frame was rejected")
	}
	images.MarkPresented(key, first.Generation, first.Raster, 1)
	if !images.WaitCurrent(0) {
		t.Fatal("presented current raster did not release the wait")
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
		func(work func() bool) bool {
			if _, err := images.ConfigureRaster(key, 900, 600, 2.0, true); err != nil {
				t.Fatal(err)
			}
			return work()
		},
		func(_ string, value map[string]interface{}) error {
			response = value
			return nil
		},
	)

	if got := response["image"].(map[string]interface{})["error"]; got != "stale" {
		t.Fatalf("frame superseded before presentation returned %v, want stale", got)
	}
	if images.CurrentPresented() {
		t.Fatal("stale frame marked the replacement raster as presented")
	}
}

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

func TestEnvelopeFromAnotherSidecarIsRefused(t *testing.T) {
	images := host.NewImages()
	key := host.ImageKey{Surface: "tab-1", Name: "view"}

	var a int
	// sidecar-a가 attachment 한 이미지
	owner := &host.ImageOwner{SidecarName: "sidecar-a", SidecarOwner: newFakeImageOwner("")}
	if err := images.Reserve(key, owner); err != nil {
		t.Fatalf("reserve failed: %v", err)
	}
	images.Set(key, unsafe.Pointer(&a))

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

	// 다른 사이드카(sidecar-b)가 같은 이미지를 보내면 notAttached 오류 반환
	decision := host.Decide(bodyBytes, "sidecar-b", "tab-1", images)
	reply, ok := decision.(*host.Reply)
	if !ok {
		t.Fatalf("expected Reply(notAttached), got %T", decision)
	}
	imageData := reply.JSON["image"].(map[string]interface{})
	if !strings.Contains(imageData["error"].(string), "notAttached") {
		t.Fatalf("expected notAttached error, got %v", imageData["error"])
	}
}

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
		func(work func() bool) bool {
			// 표시 실패를 시뮬레이션 - work 호출 없이 false 반환
			return false
		},
		func(imageName string, response map[string]interface{}) error {
			receivedImageName = imageName
			receivedResponse = response
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
