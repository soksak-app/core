//go:build diagnostics

package host

import (
	"testing"
	"unsafe"
)

// closingViewPlatform is the view platform that records the closed view documents. The view steps fail through the view fault
// injection point of attachView.
type closingViewPlatform struct {
	viewPlatform
	closed []unsafe.Pointer
}

func (p *closingViewPlatform) CloseDocument(document unsafe.Pointer) {
	p.closed = append(p.closed, document)
}

// contract: documents.create.failure-closes-document
func TestAFailedConfigurationOrLoadOfAViewClosesTheView(t *testing.T) {
	for _, step := range []string{"message", "ended", "responsiveness", "script", "load"} {
		t.Setenv(faultViewStep, step)
		fake := &closingViewPlatform{}
		saved := system
		system = fake
		s := &Surfaces{documents: NewDocuments(), events: func(string, any) {}}
		err := s.attachView("probe-surface", unsafe.Pointer(new(int)), "/config/document-data", "/plugins/probe", "probe", "ui/page.html", "channel-script", nullOriginStart())
		system = saved
		want := step + " failed"
		if step == "load" {
			want = `view of surface "probe-surface" cannot load soksak://probe/ui/page.html`
		}
		if err == nil || err.Error() != want {
			t.Fatalf("the failure of %s: %v, want %s", step, err, want)
		}
		if len(fake.closed) != 1 {
			t.Fatalf("the failure of %s closed %d view documents, want 1", step, len(fake.closed))
		}
		if loaded := len(fake.loaded) != 0; loaded != (step == "load") {
			t.Fatalf("the failure of %s loaded %v; the page loads only after the configuration", step, fake.loaded)
		}
		if _, err := s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err == nil {
			t.Fatalf("the failure of %s keeps the view recorded for its surface", step)
		}
	}
}
