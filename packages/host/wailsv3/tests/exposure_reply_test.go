package host_test

import (
	"encoding/json"
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// contract: authorization.main.known-main-caller-accepted, authorization.main.unknown-main-caller-rejected, exposure-reply.payload.main-reply-unscoped, exposure-reply.payload.scoped-reply-keeps-surface
func TestExposureReplyMainAndScopedPayloads(t *testing.T) {
	mainPayload, err := json.Marshal(host.ExposureReplyRequest{ID: 1, Result: json.RawMessage(`null`)})
	if err != nil {
		t.Fatal(err)
	}
	var main host.ExposureReplyRequest
	if err := json.Unmarshal(mainPayload, &main); err != nil {
		t.Fatal(err)
	}
	if main.Surface != "" {
		t.Fatalf("main reply unexpectedly scoped: %q", main.Surface)
	}

	scopedPayload, err := json.Marshal(host.ExposureReplyRequest{ID: 2, Surface: "tab-1", Result: json.RawMessage(`{"ok":true}`)})
	if err != nil {
		t.Fatal(err)
	}
	var scoped host.ExposureReplyRequest
	if err := json.Unmarshal(scopedPayload, &scoped); err != nil {
		t.Fatal(err)
	}
	if scoped.Surface != "tab-1" {
		t.Fatalf("scoped reply lost surface: %q", scoped.Surface)
	}
	if err := host.AuthorizeSurfaceCaller("", scoped.Surface, 42, 42); err != nil {
		t.Fatal(err)
	}
	if err := host.AuthorizeSurfaceCaller("", scoped.Surface, 41, 42); err == nil {
		t.Fatal("unknown main scope accepted")
	}
}
