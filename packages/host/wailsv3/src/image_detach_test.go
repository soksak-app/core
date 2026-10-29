package host

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
	"unsafe"
)

type imageDetachMessageOwner struct {
	events []string
}

// contract: images.reload.captures-old-image-owner
func TestReloadSurfaceImagesRetainsOldDetachTargetThroughGenerationAdvance(t *testing.T) {
	surfaces := sidecarSessionSurfaces(t)
	c := surfaces.sidecars
	c.stopped = false
	service := &sidecar{name: "fixture-sidecar", persistent: true, outbox: make(chan queuedLine, 4),
		closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{}}
	c.running["fixture-sidecar"] = service
	surfaces.images = NewImages()
	key := ImageKey{Surface: "surface-a", Name: "view"}
	if err := surfaces.images.Reserve(key, &ImageOwner{SidecarName: "fixture-sidecar", SidecarOwner: surfaces}); err != nil {
		t.Fatalf("reserve image: %v", err)
	}
	if !surfaces.images.Set(key, unsafe.Pointer(new(byte))) {
		t.Fatal("set image handle failed")
	}
	surfaces.images.mu.Lock()
	oldGeneration := surfaces.images.generations[key.Surface]
	surfaces.images.mu.Unlock()
	closed := false
	targets := surfaces.reloadSurfaceImages(key.Surface, func(unsafe.Pointer) { closed = true })
	if !closed {
		t.Fatal("native image region was not closed before the detach request")
	}
	if len(targets) != 1 || targets[0].Owner != surfaces || targets[0].Sidecar != "fixture-sidecar" || targets[0].Generation != oldGeneration {
		t.Fatalf("reload detach targets %+v, want the exact owner and pre-reload generation %d", targets, oldGeneration)
	}
	surfaces.images.mu.Lock()
	newGeneration := surfaces.images.generations[key.Surface]
	surfaces.images.mu.Unlock()
	if newGeneration <= oldGeneration {
		t.Fatalf("surface generation after native close: %d, want newer than %d", newGeneration, oldGeneration)
	}

	surfaces.imageDetachPageReady()
	ends := recordImageDetachEnds(surfaces)
	if err := surfaces.beginImageDetaches(targets); err != nil {
		t.Fatalf("begin image detach: %v", err)
	}
	line := <-service.outbox
	var sent sidecarRequest
	if err := json.Unmarshal(line.bytes, &sent); err != nil {
		t.Fatalf("decode detach request: %v", err)
	}
	var body struct {
		Image struct {
			Detach imageDetachAck `json:"detach"`
		} `json:"image"`
	}
	if err := json.Unmarshal(sent.Body, &body); err != nil {
		t.Fatalf("decode detach body: %v", err)
	}
	if sent.Surface != key.Surface || body.Image.Detach.Name != key.Name || body.Image.Detach.Generation != oldGeneration {
		t.Fatalf("detach request %s, want the closed image's old identity", sent.Body)
	}
	ack, _ := json.Marshal(map[string]any{"image": map[string]any{"detached": map[string]any{
		"request": body.Image.Detach.Request, "name": key.Name, "generation": oldGeneration,
		"ok": true, "result": "detached",
	}}})
	if !c.tryHandleImageEnvelope(surfaces, "fixture-sidecar", key.Surface, ack) {
		t.Fatal("host did not consume the supplier acknowledgement")
	}
	select {
	case <-ends:
	case <-time.After(5 * time.Second):
		t.Fatal("the acknowledgement of the old image sent no ended event")
	}
}

// sentImageDetachRequest reads the detach request that the supplier service received and returns its request id.
func sentImageDetachRequest(t *testing.T, service *sidecar) string {
	t.Helper()
	var line queuedLine
	select {
	case line = <-service.outbox:
	case <-time.After(5 * time.Second):
		t.Fatalf("supplier %s received no image detach request", service.name)
	}
	var sent sidecarRequest
	if err := json.Unmarshal(line.bytes, &sent); err != nil {
		t.Fatalf("decode detach request: %v", err)
	}
	var body struct {
		Image struct {
			Detach imageDetachAck `json:"detach"`
		} `json:"image"`
	}
	if err := json.Unmarshal(sent.Body, &body); err != nil {
		t.Fatalf("decode detach body: %v", err)
	}
	return body.Image.Detach.Request
}

// acknowledgeImageDetach sends the supplier acknowledgement fields of request for target.
func acknowledgeImageDetach(t *testing.T, c *Sidecars, owner SidecarOwner, target imageDetachTarget, request string, fields map[string]any) {
	t.Helper()
	detached := map[string]any{"request": request, "name": target.Name, "generation": target.Generation}
	for name, value := range fields {
		detached[name] = value
	}
	ack, err := json.Marshal(map[string]any{"image": map[string]any{"detached": detached}})
	if err != nil {
		t.Fatalf("encode detach acknowledgement: %v", err)
	}
	if !c.tryHandleImageEnvelope(owner, target.Sidecar, target.Surface, ack) {
		t.Fatal("host did not consume the supplier acknowledgement")
	}
}

// recordImageDetachEnds records the image-detach-ended events of the window on a channel.
func recordImageDetachEnds(surfaces *Surfaces) <-chan any {
	ends := make(chan any, 8)
	surfaces.events = func(name string, data any) {
		if name == "image-detach-ended" {
			ends <- data
		}
	}
	return ends
}

// endedEvent is the image-detach-ended data of surface with error, which is nil for a surface whose detaches all succeeded.
func endedEvent(surface string, failure any) string {
	return fmt.Sprint(map[string]any{"surface": surface, "error": failure})
}

// pendingImageDetachOf returns the pending detach of an image.
func pendingImageDetachOf(t *testing.T, surfaces *Surfaces, target imageDetachTarget) *pendingImageDetach {
	t.Helper()
	surfaces.imageDetachMu.Lock()
	defer surfaces.imageDetachMu.Unlock()
	entry := surfaces.imageDetaches[imageDetachKey{Sidecar: target.Sidecar, Surface: target.Surface, Name: target.Name}]
	if entry == nil {
		t.Fatalf("image %s of surface %s has no pending detach", target.Name, target.Surface)
	}
	return entry
}

// waitClosed waits for a channel that the waiter of a pending detach closes.
func waitClosed(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s did not occur", what)
	}
}

func imageDetachFixture(t *testing.T, names ...string) (*Surfaces, map[string]*sidecar) {
	t.Helper()
	surfaces := sidecarSessionSurfaces(t)
	c := surfaces.sidecars
	c.stopped = false
	services := map[string]*sidecar{}
	for _, name := range names {
		if _, declared := c.declared[name]; !declared {
			c.declared[name] = "build/" + name
			c.persistent[name] = true
		}
		service := &sidecar{name: name, persistent: true, outbox: make(chan queuedLine, 8),
			closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{}}
		c.running[name] = service
		services[name] = service
	}
	surfaces.imageDetachPageReady()
	return surfaces, services
}

// contract: images.detach.timeout-keeps-waiting
func TestATimedOutImageDetachIsRecordedOnceAndALateAcknowledgementEndsIt(t *testing.T) {
	isolateTraceRecords(t)
	surfaces, services := imageDetachFixture(t, "fixture-sidecar")
	c := surfaces.sidecars
	c.imageDetachTimeout = 10 * time.Millisecond
	ends := recordImageDetachEnds(surfaces)
	target := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces}
	if err := surfaces.beginImageDetaches([]imageDetachTarget{target}); err != nil {
		t.Fatalf("begin image detach: %v", err)
	}
	request := sentImageDetachRequest(t, services["fixture-sidecar"])
	want := fmt.Sprintf("image detach sidecar fixture-sidecar surface surface-a image view generation 7 request %s timed out", request)
	entry := pendingImageDetachOf(t, surfaces, target)
	waitClosed(t, entry.timedOut, "the image detach timeout")
	if err := surfaces.pendingImageDetachError("surface-a"); err == nil {
		t.Fatal("the surface stopped waiting at the timeout")
	}
	if err := surfaces.beginImageDetaches([]imageDetachTarget{target}); err != nil {
		t.Fatalf("begin image detach on the next page start: %v", err)
	}
	select {
	case line := <-services["fixture-sidecar"].outbox:
		t.Fatalf("a page start sent a second detach for a pending image: %s", line.bytes)
	default:
	}
	acknowledgeImageDetach(t, c, surfaces, target, request, map[string]any{"ok": true, "result": "detached"})
	select {
	case data := <-ends:
		if fmt.Sprint(data) != endedEvent("surface-a", nil) {
			t.Fatalf("ended event data %v, want surface-a without error", data)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a late acknowledgement sent no ended event")
	}
	errors := bufferedTraces(t, "host.record.error")
	if len(errors) != 1 || errors[0]["where"] != "image detach" || errors[0]["text"] != want {
		t.Fatalf("error records %v, want one timeout record %q", errors, want)
	}
}

// contract: images.detach.surface-ends-after-its-last-detach
func TestASurfaceEndsItsDetachesOnlyAfterTheAcknowledgementOfEachOfItsImages(t *testing.T) {
	surfaces, services := imageDetachFixture(t, "fixture-sidecar", "other-sidecar")
	c := surfaces.sidecars
	ends := recordImageDetachEnds(surfaces)
	targets := []imageDetachTarget{
		{Surface: "surface-a", Name: "view-a", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces},
		{Surface: "surface-a", Name: "view-b", Sidecar: "other-sidecar", Generation: 8, Owner: surfaces},
	}
	if err := surfaces.beginImageDetaches(targets); err != nil {
		t.Fatalf("begin image detaches: %v", err)
	}
	first := sentImageDetachRequest(t, services["fixture-sidecar"])
	second := sentImageDetachRequest(t, services["other-sidecar"])
	firstEntry := pendingImageDetachOf(t, surfaces, targets[0])
	acknowledgeImageDetach(t, c, surfaces, targets[0], first, map[string]any{"ok": true, "result": "detached"})
	waitClosed(t, firstEntry.ended, "the end of the first detach")
	if err := surfaces.pendingImageDetachError("surface-a"); err == nil || !strings.Contains(err.Error(), "image view-b") {
		t.Fatalf("pending detach of surface-a after the first acknowledgement: %v, want image view-b", err)
	}
	select {
	case data := <-ends:
		t.Fatalf("the surface sent an ended event with one of two detaches pending: %v", data)
	default:
	}
	acknowledgeImageDetach(t, c, surfaces, targets[1], second, map[string]any{"ok": true, "result": "alreadyAbsent"})
	select {
	case <-ends:
	case <-time.After(5 * time.Second):
		t.Fatal("the surface sent no ended event after the acknowledgement of each image")
	}
	if err := surfaces.pendingImageDetachError("surface-a"); err != nil {
		t.Fatalf("pending detach after both acknowledgements: %v", err)
	}
}

// contract: images.detach.refusal-ends-pending
func TestARejectedImageDetachEndsThePendingDetachWithItsErrorInTheEndedEvent(t *testing.T) {
	isolateTraceRecords(t)
	surfaces, services := imageDetachFixture(t, "fixture-sidecar")
	c := surfaces.sidecars
	ends := recordImageDetachEnds(surfaces)
	target := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces}
	if err := surfaces.beginImageDetaches([]imageDetachTarget{target}); err != nil {
		t.Fatalf("begin image detach: %v", err)
	}
	request := sentImageDetachRequest(t, services["fixture-sidecar"])
	entry := pendingImageDetachOf(t, surfaces, target)
	acknowledgeImageDetach(t, c, surfaces, target, request, map[string]any{"ok": false, "error": "staleGeneration", "currentGeneration": 8})
	waitClosed(t, entry.ended, "the end of the rejected detach")
	if err := surfaces.pendingImageDetachError("surface-a"); err != nil {
		t.Fatalf("pending detach after the rejection: %v", err)
	}
	want := fmt.Sprintf("image detach sidecar fixture-sidecar surface surface-a image view generation 7 request %s rejected: staleGeneration (current generation 8)", request)
	select {
	case data := <-ends:
		if fmt.Sprint(data) != endedEvent("surface-a", want) {
			t.Fatalf("ended event data %v, want the rejection %q", data, want)
		}
	default:
		t.Fatal("a rejected detach sent no ended event")
	}
	// The page shows the rejection through its error display, which writes its one record.
	if errors := bufferedTraces(t, "host.record.error"); len(errors) != 0 {
		t.Fatalf("error records %v, want none from the host", errors)
	}
}

// contract: images.detach.refusal-ends-pending
func TestTheEndedEventOfASurfaceCarriesEachRejectionInImageNameOrder(t *testing.T) {
	surfaces, services := imageDetachFixture(t, "fixture-sidecar")
	c := surfaces.sidecars
	ends := recordImageDetachEnds(surfaces)
	targets := []imageDetachTarget{
		{Surface: "surface-a", Name: "view-b", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces},
		{Surface: "surface-a", Name: "view-a", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces},
	}
	if err := surfaces.beginImageDetaches(targets); err != nil {
		t.Fatalf("begin image detaches: %v", err)
	}
	requests := []string{sentImageDetachRequest(t, services["fixture-sidecar"]), sentImageDetachRequest(t, services["fixture-sidecar"])}
	for index, target := range targets {
		acknowledgeImageDetach(t, c, surfaces, target, requests[index], map[string]any{"ok": false, "error": "imageNameMismatch"})
	}
	want := fmt.Sprintf("image detach sidecar fixture-sidecar surface surface-a image view-a generation 7 request %s rejected: imageNameMismatch; "+
		"image detach sidecar fixture-sidecar surface surface-a image view-b generation 7 request %s rejected: imageNameMismatch", requests[1], requests[0])
	select {
	case data := <-ends:
		if fmt.Sprint(data) != endedEvent("surface-a", want) {
			t.Fatalf("ended event data %v, want both rejections %q", data, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the surface sent no ended event after both rejections")
	}
}

// contract: images.detach.session-end-releases
func TestTheEndOfTheSupplierOrTheSurfaceSessionEndsThePendingDetach(t *testing.T) {
	surfaces, services := imageDetachFixture(t, "fixture-sidecar")
	c := surfaces.sidecars
	ends := recordImageDetachEnds(surfaces)
	supplier := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces}
	session := imageDetachTarget{Surface: "surface-b", Name: "view", Sidecar: "fixture-sidecar", Generation: 3, Owner: surfaces}
	if err := surfaces.beginImageDetaches([]imageDetachTarget{supplier, session}); err != nil {
		t.Fatalf("begin image detaches: %v", err)
	}
	sentImageDetachRequest(t, services["fixture-sidecar"])
	sentImageDetachRequest(t, services["fixture-sidecar"])
	supplierEntry, sessionEntry := pendingImageDetachOf(t, surfaces, supplier), pendingImageDetachOf(t, surfaces, session)
	c.owners["surface-b"] = surfaces
	c.closeSurface("surface-b")
	waitClosed(t, sessionEntry.ended, "the end of the detach of surface-b")
	if err := surfaces.pendingImageDetachError("surface-b"); err != nil {
		t.Fatalf("pending detach of surface-b after its session ended: %v", err)
	}
	if err := surfaces.pendingImageDetachError("surface-a"); err == nil {
		t.Fatal("the end of the session of surface-b ended the detach of surface-a")
	}
	select {
	case data := <-ends:
		t.Fatalf("the end of a surface session sent an ended event: %v", data)
	default:
	}
	c.failImageDetaches("fixture-sidecar")
	waitClosed(t, supplierEntry.ended, "the end of the detach of surface-a")
	if err := surfaces.pendingImageDetachError("surface-a"); err != nil {
		t.Fatalf("pending detach of surface-a after its supplier ended: %v", err)
	}
	want := fmt.Sprintf("image detach sidecar fixture-sidecar surface surface-a image view generation 7 request %s ended: the supplier connection ended", supplierEntry.id)
	select {
	case data := <-ends:
		if fmt.Sprint(data) != endedEvent("surface-a", want) {
			t.Fatalf("ended event data %v, want the supplier end %q", data, want)
		}
	default:
		t.Fatal("the end of the supplier sent no ended event")
	}
}

// contract: images.detach.ended-event-waits-for-ready
func TestAnEndedEventBeforeThePageIsReadyIsSentWhenThePageReportsReady(t *testing.T) {
	surfaces, services := imageDetachFixture(t, "fixture-sidecar")
	c := surfaces.sidecars
	ends := recordImageDetachEnds(surfaces)
	surfaces.imageDetachPageStarting()
	target := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces}
	if err := surfaces.beginImageDetaches([]imageDetachTarget{target}); err != nil {
		t.Fatalf("begin image detach: %v", err)
	}
	request := sentImageDetachRequest(t, services["fixture-sidecar"])
	entry := pendingImageDetachOf(t, surfaces, target)
	acknowledgeImageDetach(t, c, surfaces, target, request, map[string]any{"ok": true, "result": "detached"})
	waitClosed(t, entry.ended, "the end of the detach")
	select {
	case data := <-ends:
		t.Fatalf("the ended event was sent to a page that is not ready: %v", data)
	default:
	}
	surfaces.imageDetachPageReady()
	select {
	case data := <-ends:
		if fmt.Sprint(data) != endedEvent("surface-a", nil) {
			t.Fatalf("ended event data %v, want surface-a without error", data)
		}
	default:
		t.Fatal("the ready page did not receive the ended event")
	}
}

// contract: images.detach.ended-event-waits-for-ready
func TestAPageStartRecordsTheFailuresOfTheEndsItClears(t *testing.T) {
	isolateTraceRecords(t)
	surfaces, services := imageDetachFixture(t, "fixture-sidecar")
	c := surfaces.sidecars
	ends := recordImageDetachEnds(surfaces)
	surfaces.imageDetachPageStarting()
	target := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces}
	if err := surfaces.beginImageDetaches([]imageDetachTarget{target}); err != nil {
		t.Fatalf("begin image detach: %v", err)
	}
	request := sentImageDetachRequest(t, services["fixture-sidecar"])
	entry := pendingImageDetachOf(t, surfaces, target)
	acknowledgeImageDetach(t, c, surfaces, target, request, map[string]any{"ok": false, "error": "imageNameMismatch"})
	waitClosed(t, entry.ended, "the end of the rejected detach")
	surfaces.imageDetachPageStarting()
	surfaces.imageDetachPageReady()
	select {
	case data := <-ends:
		t.Fatalf("a cleared end reached the next page: %v", data)
	default:
	}
	want := fmt.Sprintf("image detach sidecar fixture-sidecar surface surface-a image view generation 7 request %s rejected: imageNameMismatch", request)
	errors := bufferedTraces(t, "host.record.error")
	if len(errors) != 1 || errors[0]["where"] != "image detach" || errors[0]["text"] != want {
		t.Fatalf("error records %v, want the cleared rejection %q", errors, want)
	}
}

func (o *imageDetachMessageOwner) ProjectRoot() string { return "/fixture/root" }

func (o *imageDetachMessageOwner) Emit(name string, _ ...any) { o.events = append(o.events, name) }

// contract: images.detach.ack-consumed
func TestImageDetachAcknowledgementIsConsumedByTheHost(t *testing.T) {
	owner := &imageDetachMessageOwner{}
	target := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: owner}
	waiter := &imageDetachWaiter{target: target, owner: owner, result: make(chan imageDetachResult, 1)}
	sidecars := &Sidecars{imageDetachRequests: map[string]*imageDetachWaiter{"request-1": waiter}}
	body := json.RawMessage(`{"image":{"detached":{"request":"request-1","name":"view","generation":7,"ok":true,"result":"detached"}}}`)

	if !sidecars.tryHandleImageEnvelope(owner, "fixture-sidecar", "surface-a", body) {
		t.Fatal("image.detached was not consumed by the host")
	}
	if len(owner.events) != 0 {
		t.Fatalf("host events %v, want no page event for an internal detach acknowledgement", owner.events)
	}
	if result := <-waiter.result; !result.ok || result.result != "detached" {
		t.Fatalf("detach result %+v, want detached success", result)
	}
}

// contract: images.detach.ack-consumed
func TestImageDetachAcknowledgementIgnoresAnUnrelatedDeepMember(t *testing.T) {
	deep := strings.Repeat("[", 140) + "0" + strings.Repeat("]", 140)
	cases := []string{
		`{"image":{"detached":{"request":"request-1","name":"view","generation":7,"ok":true,"result":"detached"}},"metadata":` + deep + `}`,
		`{"image":{"detached":{"request":"request-1","name":"view","generation":7,"ok":true,"result":"detached"},"metadata":` + deep + `}}`,
		`{"image":{"detached":{"request":"request-1","name":"view","generation":7,"ok":true,"result":"detached","metadata":` + deep + `}}}`,
	}

	for index, body := range cases {
		owner := &imageDetachMessageOwner{}
		target := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: owner}
		request := fmt.Sprintf("request-%d", index+1)
		waiter := &imageDetachWaiter{target: target, owner: owner, result: make(chan imageDetachResult, 1)}
		sidecars := &Sidecars{imageDetachRequests: map[string]*imageDetachWaiter{request: waiter}}
		body = strings.ReplaceAll(body, "request-1", request)

		if !sidecars.tryHandleImageEnvelope(owner, "fixture-sidecar", "surface-a", json.RawMessage(body)) {
			t.Fatalf("image.detached was not consumed for deep member location %d", index)
		}
		if len(owner.events) != 0 {
			t.Fatalf("host events %v, want no page event for deep member location %d", owner.events, index)
		}
		if result := <-waiter.result; !result.ok || result.result != "detached" {
			t.Fatalf("detach result %+v, want detached success for deep member location %d", result, index)
		}
	}
}

// contract: images.detach.ack-exact-owner
func TestImageDetachWaitsForTheMatchingSupplierAcknowledgement(t *testing.T) {
	surfaces := sidecarSessionSurfaces(t)
	c := surfaces.sidecars
	c.stopped = false
	service := &sidecar{name: "fixture-sidecar", persistent: true, outbox: make(chan queuedLine, 4),
		closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{}}
	c.running["fixture-sidecar"] = service
	target := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces}

	request, result, err := c.beginImageDetach(target)
	if err != nil {
		t.Fatalf("begin image detach: %v", err)
	}
	line := <-service.outbox
	var sent sidecarRequest
	if err := json.Unmarshal(line.bytes, &sent); err != nil {
		t.Fatalf("decode detach request: %v", err)
	}
	var body struct {
		Image struct {
			Detach imageDetachAck `json:"detach"`
		} `json:"image"`
	}
	if err := json.Unmarshal(sent.Body, &body); err != nil {
		t.Fatalf("decode detach body: %v", err)
	}
	if sent.Surface != target.Surface || body.Image.Detach.Request != request || body.Image.Detach.Name != target.Name || body.Image.Detach.Generation != target.Generation {
		t.Fatalf("sent detach surface/body: %q %s, want exact target and request %q", sent.Surface, sent.Body, request)
	}

	otherOwner := &imageDetachMessageOwner{}
	wrong := []struct {
		name    string
		owner   SidecarOwner
		sidecar string
		surface string
		ack     imageDetachAck
	}{
		{"owner", otherOwner, target.Sidecar, target.Surface, imageDetachAck{Request: request, Name: target.Name, Generation: target.Generation, OK: true, Result: "detached"}},
		{"supplier", surfaces, "other-sidecar", target.Surface, imageDetachAck{Request: request, Name: target.Name, Generation: target.Generation, OK: true, Result: "detached"}},
		{"surface", surfaces, target.Sidecar, "other-surface", imageDetachAck{Request: request, Name: target.Name, Generation: target.Generation, OK: true, Result: "detached"}},
		{"request", surfaces, target.Sidecar, target.Surface, imageDetachAck{Request: "other-request", Name: target.Name, Generation: target.Generation, OK: true, Result: "detached"}},
		{"name", surfaces, target.Sidecar, target.Surface, imageDetachAck{Request: request, Name: "other-image", Generation: target.Generation, OK: true, Result: "detached"}},
		{"generation", surfaces, target.Sidecar, target.Surface, imageDetachAck{Request: request, Name: target.Name, Generation: target.Generation + 1, OK: true, Result: "detached"}},
	}
	for _, tc := range wrong {
		c.handleImageDetachAck(tc.owner, tc.sidecar, tc.surface, tc.ack)
		select {
		case <-result:
			t.Fatalf("a mismatched %s settled the image detach", tc.name)
		default:
		}
	}
	c.handleImageDetachAck(surfaces, target.Sidecar, target.Surface, imageDetachAck{
		Request: request, Name: target.Name, Generation: target.Generation, OK: true, Result: "detached",
	})
	select {
	case got := <-result:
		if !got.ok || got.result != "detached" {
			t.Fatalf("matching acknowledgement result %+v, want detached success", got)
		}
	case <-time.After(time.Second):
		t.Fatal("the matching acknowledgement did not settle the image detach")
	}
}

// contract: images.reload.captures-old-image-owner
func TestImageDetachRequestIdentityDoesNotRestartWithTheApplication(t *testing.T) {
	requests := map[string]bool{}
	for _, surface := range []string{"surface-before-restart", "surface-after-restart"} {
		surfaces := sidecarSessionSurfaces(t)
		c := surfaces.sidecars
		c.stopped = false
		c.running["fixture-sidecar"] = &sidecar{name: "fixture-sidecar", persistent: true, outbox: make(chan queuedLine, 1), closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{}}
		request, _, err := c.beginImageDetach(imageDetachTarget{Owner: surfaces, Sidecar: "fixture-sidecar", Surface: surface, Name: "view", Generation: 1})
		if err != nil {
			t.Fatal(err)
		}
		if requests[request] {
			t.Fatalf("application restart reused detach request %q for another surface", request)
		}
		requests[request] = true
	}
}

// A detach that its supplier does not acknowledge keeps only its own surface pending: the page start does not fail, a page
// send of that surface is refused with the pending detach, and a send of another surface passes.
// contract: images.detach.pending-surface-is-refused
func TestAnUnacknowledgedImageDetachKeepsOnlyItsSurfacePending(t *testing.T) {
	surfaces := sidecarSessionSurfaces(t)
	c := surfaces.sidecars
	c.stopped = false
	c.imageDetachTimeout = 10 * time.Millisecond
	service := &sidecar{name: "fixture-sidecar", persistent: true, outbox: make(chan queuedLine, 8),
		closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{}}
	c.running["fixture-sidecar"] = service
	target := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces}
	if err := surfaces.beginImageDetaches([]imageDetachTarget{target}); err != nil {
		t.Fatalf("an unacknowledged image detach failed the page start: %v", err)
	}
	<-service.outbox
	err := surfaces.SidecarSend("fixture-sidecar", "surface-a", json.RawMessage(`{"open":{}}`), nil)
	if err == nil || !strings.Contains(err.Error(), "image detach sidecar fixture-sidecar surface surface-a image view generation 7") ||
		!strings.HasSuffix(err.Error(), "is pending") {
		t.Fatalf("send of the pending surface returned %v, want the pending detach", err)
	}
	if err := surfaces.SidecarSend("fixture-sidecar", "surface-b", json.RawMessage(`{"open":{}}`), nil); err != nil {
		t.Fatalf("send of another surface: %v", err)
	}
	err = surfaces.attachCheckedImage(ImageKey{Surface: "surface-a", Name: "view"}, ImageRequest{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar"})
	if err == nil || !strings.HasPrefix(err.Error(), "image detach sidecar fixture-sidecar surface surface-a image view generation 7") ||
		!strings.HasSuffix(err.Error(), "is pending") {
		t.Fatalf("image attach of the pending surface returned %v, want the pending detach", err)
	}
}
