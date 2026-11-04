package host

import (
	"encoding/json"
	"testing"
)

// contract: images.relay.preserves-compose-marked-range
func TestImageChangedPreservesComposeMarkedRangeOnOwningSurface(t *testing.T) {
	surfaces := NewSurfaces(nil, nil)
	surfaces.views["probe-surface"] = &nativeWebview{}
	var eventName string
	var eventData map[string]any
	surfaces.events = func(name string, data any) {
		eventName = name
		eventData = data.(map[string]any)
	}
	body := `{"type":"compose","text":"한","markedRange":{"location":0,"length":1},"selectedRange":{"location":1,"length":0},"replacementRange":null,"attributed":false}`

	surfaces.imageChanged(ImageKey{Surface: "probe-surface", Name: "probe-region"}, body)

	if eventName != "image-event" {
		t.Fatalf("event name %q, want image-event", eventName)
	}
	if eventData["surface"] != "probe-surface" || eventData["name"] != "probe-region" {
		t.Fatalf("event identity %v, want the owning surface and region", eventData)
	}
	var received map[string]any
	if err := json.Unmarshal(eventData["event"].(json.RawMessage), &received); err != nil {
		t.Fatalf("decode relayed event: %v", err)
	}
	if received["markedRange"] == nil {
		t.Fatalf("relayed compose event lost markedRange: %s", eventData["event"])
	}
	markedRange := received["markedRange"].(map[string]any)
	if markedRange["location"] != float64(0) || markedRange["length"] != float64(1) {
		t.Fatalf("relayed markedRange %v, want location 0 and length 1", markedRange)
	}
}
