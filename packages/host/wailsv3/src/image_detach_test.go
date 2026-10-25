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

	done := make(chan error, 1)
	go func() { done <- surfaces.awaitImageDetaches(targets) }()
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
	if err := <-done; err != nil {
		t.Fatalf("image-less page start barrier: %v", err)
	}
}

// contract: images.detach.timeout-retains-target
func TestFailedImageDetachRemainsPendingForTheNextPageStart(t *testing.T) {
	surfaces := sidecarSessionSurfaces(t)
	c := surfaces.sidecars
	c.stopped = false
	c.imageDetachTimeout = 10 * time.Millisecond
	service := &sidecar{name: "fixture-sidecar", persistent: true, outbox: make(chan queuedLine, 4),
		closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{}}
	c.running["fixture-sidecar"] = service
	target := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces}
	if err := surfaces.awaitImageDetaches([]imageDetachTarget{target}); err == nil {
		t.Fatal("missing supplier acknowledgement did not fail page startup")
	}
	if len(surfaces.pendingImageDetaches) != 1 || surfaces.pendingImageDetaches[0] != target {
		t.Fatalf("pending detach targets %+v, want the exact target retained for retry", surfaces.pendingImageDetaches)
	}
	<-service.outbox

	done := make(chan error, 1)
	go func() { done <- surfaces.awaitImageDetaches(nil) }()
	line := <-service.outbox
	var sent sidecarRequest
	if err := json.Unmarshal(line.bytes, &sent); err != nil {
		t.Fatalf("decode retried detach request: %v", err)
	}
	var body struct {
		Image struct {
			Detach imageDetachAck `json:"detach"`
		} `json:"image"`
	}
	if err := json.Unmarshal(sent.Body, &body); err != nil {
		t.Fatalf("decode retried detach body: %v", err)
	}
	ack, _ := json.Marshal(map[string]any{"image": map[string]any{"detached": map[string]any{
		"request": body.Image.Detach.Request, "name": target.Name, "generation": target.Generation,
		"ok": true, "result": "alreadyDetached",
	}}})
	c.tryHandleImageEnvelope(surfaces, target.Sidecar, target.Surface, ack)
	if err := <-done; err != nil {
		t.Fatalf("retried image detach: %v", err)
	}
	if len(surfaces.pendingImageDetaches) != 0 {
		t.Fatalf("pending detach targets after acknowledgement %+v, want none", surfaces.pendingImageDetaches)
	}
}

// contract: images.detach.waits-for-every-region
func TestPageStartWaitsForEveryImageDetachAcknowledgement(t *testing.T) {
	surfaces := sidecarSessionSurfaces(t)
	c := surfaces.sidecars
	c.stopped = false
	c.declared["other-sidecar"] = "build/other-worker"
	c.persistent["other-sidecar"] = true
	services := map[string]*sidecar{}
	for _, name := range []string{"fixture-sidecar", "other-sidecar"} {
		service := &sidecar{name: name, persistent: true, outbox: make(chan queuedLine, 4),
			closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{}}
		c.running[name] = service
		services[name] = service
	}
	targets := []imageDetachTarget{
		{Surface: "surface-a", Name: "view-a", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces},
		{Surface: "surface-a", Name: "view-b", Sidecar: "other-sidecar", Generation: 8, Owner: surfaces},
	}
	done := make(chan error, 1)
	go func() { done <- c.detachImages(targets) }()
	acks := make(map[string]json.RawMessage, len(targets))
	for _, target := range targets {
		line := <-services[target.Sidecar].outbox
		var sent sidecarRequest
		if err := json.Unmarshal(line.bytes, &sent); err != nil {
			t.Fatalf("decode detach request for %s: %v", target.Sidecar, err)
		}
		var body struct {
			Image struct {
				Detach imageDetachAck `json:"detach"`
			} `json:"image"`
		}
		if err := json.Unmarshal(sent.Body, &body); err != nil {
			t.Fatalf("decode detach body for %s: %v", target.Sidecar, err)
		}
		ack, err := json.Marshal(map[string]any{"image": map[string]any{"detached": map[string]any{
			"request": body.Image.Detach.Request, "name": target.Name, "generation": target.Generation,
			"ok": true, "result": "detached",
		}}})
		if err != nil {
			t.Fatalf("encode detach acknowledgement: %v", err)
		}
		acks[target.Sidecar] = ack
	}
	c.tryHandleImageEnvelope(surfaces, "fixture-sidecar", targets[0].Surface, acks["fixture-sidecar"])
	select {
	case err := <-done:
		t.Fatalf("page start completed after only one of two detach acknowledgements: %v", err)
	default:
	}
	c.tryHandleImageEnvelope(surfaces, "other-sidecar", targets[1].Surface, acks["other-sidecar"])
	if err := <-done; err != nil {
		t.Fatalf("page start after all image detach acknowledgements: %v", err)
	}
}

// contract: images.detach.refusal-fails-start
func TestRejectedImageDetachFailsPageStartAndRetainsTheTarget(t *testing.T) {
	surfaces := sidecarSessionSurfaces(t)
	c := surfaces.sidecars
	c.stopped = false
	service := &sidecar{name: "fixture-sidecar", persistent: true, outbox: make(chan queuedLine, 4),
		closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{}}
	c.running["fixture-sidecar"] = service
	target := imageDetachTarget{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar", Generation: 7, Owner: surfaces}
	done := make(chan error, 1)
	go func() { done <- surfaces.awaitImageDetaches([]imageDetachTarget{target}) }()
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
	ack, err := json.Marshal(map[string]any{"image": map[string]any{"detached": map[string]any{
		"request": body.Image.Detach.Request, "name": target.Name, "generation": target.Generation,
		"ok": false, "error": "staleGeneration", "currentGeneration": 8,
	}}})
	if err != nil {
		t.Fatalf("encode detach acknowledgement: %v", err)
	}
	c.tryHandleImageEnvelope(surfaces, target.Sidecar, target.Surface, ack)
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "staleGeneration") || !strings.Contains(err.Error(), "current generation 8") {
			t.Fatalf("page start failure %v, want explicit stale-generation error", err)
		}
	case <-time.After(time.Second):
		t.Fatal("supplier rejection did not fail page startup")
	}
	if len(surfaces.pendingImageDetaches) != 1 || surfaces.pendingImageDetaches[0] != target {
		t.Fatalf("pending detach targets %+v, want the exact rejected target retained", surfaces.pendingImageDetaches)
	}
}

func (o *imageDetachMessageOwner) ProjectRoot() string { return "/fixture/root" }

func (o *imageDetachMessageOwner) Emit(name string, _ ...any) { o.events = append(o.events, name) }

// contract: sidecar.image-detach-acknowledgement
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
