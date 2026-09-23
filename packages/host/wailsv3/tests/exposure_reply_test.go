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
	if surface, err := host.ReplySurface(main.Surface); err != nil || surface != "" {
		t.Fatalf("main reply unexpectedly scoped: %q (%v)", surface, err)
	}

	scopedPayload, err := json.Marshal(host.ExposureReplyRequest{ID: 2, Surface: json.RawMessage(`"tab-1"`), Result: json.RawMessage(`{"ok":true}`)})
	if err != nil {
		t.Fatal(err)
	}
	var scoped host.ExposureReplyRequest
	if err := json.Unmarshal(scopedPayload, &scoped); err != nil {
		t.Fatal(err)
	}
	surface, err := host.ReplySurface(scoped.Surface)
	if err != nil || surface != "tab-1" {
		t.Fatalf("scoped reply lost surface: %q (%v)", surface, err)
	}
	if err := host.AuthorizeSurfaceCaller("", surface, 42, 42); err != nil {
		t.Fatal(err)
	}
	if err := host.AuthorizeSurfaceCaller("", surface, 41, 42); err == nil {
		t.Fatal("unknown main scope accepted")
	}
}

// contract: exposure-reply.target.main-and-surface-distinct, exposure-reply.target.invalid-surface-rejected
func TestExposureReplyTargetsTheMainDocumentOrOneSurface(t *testing.T) {
	var reply host.ExposureReplyRequest
	if err := json.Unmarshal([]byte(`{"id":1,"result":null}`), &reply); err != nil {
		t.Fatal(err)
	}
	if surface, err := host.ReplySurface(reply.Surface); err != nil || surface != "" {
		t.Fatalf("a reply without surface targets %q (%v), want the main document", surface, err)
	}
	if err := json.Unmarshal([]byte(`{"id":2,"surface":"tab-1","result":null}`), &reply); err != nil {
		t.Fatal(err)
	}
	if surface, err := host.ReplySurface(reply.Surface); err != nil || surface != "tab-1" {
		t.Fatalf("a surface reply targets %q (%v), want tab-1", surface, err)
	}
	// null, 빈 문자열, 숫자, 객체는 메인 문서의 답이 아니라 오류다.
	for _, body := range []string{`null`, `""`, `3`, `{}`} {
		if err := json.Unmarshal([]byte(`{"id":3,"surface":`+body+`,"result":null}`), &reply); err != nil {
			t.Fatal(err)
		}
		if surface, err := host.ReplySurface(reply.Surface); err == nil {
			t.Fatalf("surface %s was accepted as %q", body, surface)
		}
	}
}
