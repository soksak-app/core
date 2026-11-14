//go:build diagnostics

package host

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// contract: documents.create.failure-closes-document
// A view step that fails closes the web view of the view: the window holds the web views that it held before the attachment. The step
// fails through the view fault injection point of attachView, after the platform call of the step returned.
func TestAFailedConfigurationOrLoadOfAViewClosesTheView(t *testing.T) {
	for _, step := range []string{"message", "ended", "responsiveness", "script", "load"} {
		t.Run(step, func(t *testing.T) {
			p := newViewProbe(t, Theme{})
			before := p.webviews(t)
			t.Setenv(faultViewStep, step)
			err := p.attach(t, nullOriginStart(), "ui/page.html")
			want := step + " failed"
			if step == "load" {
				want = `view of surface "probe-surface" cannot load soksak://probe/ui/page.html`
			}
			if err == nil || err.Error() != want {
				t.Fatalf("the failure of %s: %v, want %s", step, err, want)
			}
			if after := p.webviews(t); after != before {
				t.Fatalf("the failure of %s left %d web views in the window, want the %d that it held before", step, after, before)
			}
			if _, err := p.s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err == nil {
				t.Fatalf("the failure of %s keeps the view recorded for its surface", step)
			}
		})
	}
}

// realDocument creates a document region of plugin probe on the surface of the probe, as createDocument does, and returns it. The change
// receiver of the document is changed. The caller closes the document.
func realDocument(t *testing.T, p *viewProbe, changed func(string)) unsafe.Pointer {
	t.Helper()
	folder, err := filepath.Abs(filepath.Join("testdata", "view-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	var handle unsafe.Pointer
	runOnMainThread(func() {
		handle, err = system.CreateDocument(p.surface, platform.DocumentOptions{
			Directory: viewStoreDirectory(t), Folder: folder, Plugin: "probe", Label: ProcessLabel("probe", "page"),
		}, changed)
	})
	if err != nil {
		t.Fatalf("create the document region: %v", err)
	}
	return handle
}

// realInteractionState returns the interactionState of a real document region that loaded testdata/view-plugin/ui/page.html: the state
// that a restore accepts. The wait ends with the change that reports the loaded history entry.
func realInteractionState(t *testing.T, p *viewProbe) string {
	t.Helper()
	loaded := make(chan struct{}, 1)
	var once sync.Once
	source := realDocument(t, p, func(text string) {
		var state struct {
			Loading bool `json:"loading"`
			History struct {
				Entries []json.RawMessage `json:"entries"`
			} `json:"history"`
		}
		if json.Unmarshal([]byte(text), &state) == nil && !state.Loading && len(state.History.Entries) == 1 {
			once.Do(func() { close(loaded) })
		}
	})
	var accepted bool
	runOnMainThread(func() { accepted = system.LoadDocument(source, "soksak://probe/ui/page.html") })
	if !accepted {
		t.Fatal("the document region refused the page of the plugin")
	}
	select {
	case <-loaded:
	case <-time.After(10 * time.Second):
		t.Fatal("the document region did not report the loaded page")
	}
	var state string
	var ok bool
	runOnMainThread(func() {
		state, ok = system.DocumentInteractionState(source)
		system.CloseDocument(source)
	})
	if !ok || state == "" {
		t.Fatalf("the loaded document region has no interactionState (%q, %v)", state, ok)
	}
	return state
}

// creationSetup is the configuration of the region page of tab-1, with the restored history of state and the requests effect of its attach.
func creationSetup(state string) documentSetup {
	return documentSetup{
		name:    "page",
		restore: state,
		message: func(string) {},
		stream:  func(string) {},
		event:   func(string) {},
		effects: []StreamEffect{{Key: DocumentKey{Surface: "tab-1", Name: "page"}, Stream: "requests", On: true}},
	}
}

// stepsUntil returns the steps that run up to the failure of fail, the appearance and the background included.
func stepsUntil(fail string) []string {
	all := []string{"restore", "appearance", "background", "message", "stream", "stream on", "event"}
	for i, step := range all {
		if step == fail {
			return all[:i+1]
		}
	}
	return all
}

// configureOnMainThread configures document with setup as the creation does, on the main thread.
func configureOnMainThread(document unsafe.Pointer, setup documentSetup) error {
	var err error
	runOnMainThread(func() { err = configureDocument(document, setup) })
	return err
}

// contract: documents.create.failure-closes-document
// A failed step of the configuration of a real document region closes it: the window holds the web views that it held before the document.
// The step fails through the document fault injection point of configureSteps, after the platform call of the step returned, and the later
// steps do not run.
func TestAFailedStepOfTheCreationClosesTheDocument(t *testing.T) {
	p := newViewProbe(t, Theme{})
	state := realInteractionState(t, p)
	for _, fail := range []string{"restore", "message", "stream", "stream on", "event"} {
		t.Run(fail, func(t *testing.T) {
			before := p.webviews(t)
			document := realDocument(t, p, func(string) {})
			t.Setenv(faultDocumentStep, fail)
			documentStepsRan()
			err := configureOnMainThread(document, creationSetup(state))
			want := fail + " failed"
			switch fail {
			case "restore":
				want = "document page: restore failed"
			case "stream on":
				want = `document "page" does not accept stream "requests"`
			}
			if err == nil || err.Error() != want {
				t.Fatalf("the failure of %s: %v, want %s", fail, err, want)
			}
			if after := p.webviews(t); after != before {
				t.Fatalf("the failure of %s left %d web views in the window, want the %d that it held before the document", fail, after, before)
			}
			if got, want := documentStepsRan(), stepsUntil(fail); !reflect.DeepEqual(got, want) {
				t.Fatalf("the failure of %s ran the steps %v, want %v", fail, got, want)
			}
		})
	}
}

// contract: documents.create.failure-closes-document
func TestACreationWithoutFailureKeepsTheDocument(t *testing.T) {
	p := newViewProbe(t, Theme{})
	state := realInteractionState(t, p)
	before := p.webviews(t)
	document := realDocument(t, p, func(string) {})
	t.Cleanup(func() { runOnMainThread(func() { system.CloseDocument(document) }) })
	documentStepsRan()
	if err := configureOnMainThread(document, creationSetup(state)); err != nil {
		t.Fatal(err)
	}
	if got, want := documentStepsRan(), stepsUntil(""); !reflect.DeepEqual(got, want) {
		t.Fatalf("steps %v, want %v", got, want)
	}
	if after := p.webviews(t); after != before+1 {
		t.Fatalf("the window holds %d web views, want the %d with the configured document", after, before+1)
	}
}

// contract: images.attach.one-main-step
// The read of the window state fails through the fault injection point of the read, after the platform call returned.
func TestAFailedAttachTakesBackItsName(t *testing.T) {
	surfaces, p := attachSurfaces(t)
	t.Setenv(faultWindowOnScreen, "fail")
	key, request := ImageKey{Surface: "surface-a", Name: "view"}, ImageRequest{Surface: "surface-a", Name: "view", Sidecar: "fixture-sidecar"}
	if err := surfaces.attachCheckedImage(key, request); err == nil || err.Error() != "the window state cannot be read" {
		t.Fatalf("attach: %v", err)
	}
	if err := surfaces.images.Reserve(key, &ImageOwner{SidecarName: "fixture-sidecar", SidecarOwner: surfaces}); err != nil {
		t.Fatalf("the failed attach kept its name: %v", err)
	}
	if regions := regionsOfSurface(t, p); regions != 0 {
		t.Fatalf("the failed attach left %d regions", regions)
	}
}
