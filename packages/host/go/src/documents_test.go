package host

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// creationSteps are the steps of the configuration of a created document region that can fail, in their order. Setting the appearance and the
// background of a document returns no error.
var creationSteps = []string{"restore", "message", "stream", "stream on", "event"}

// creationPlatform is the platform of the creation tests. Each document operation records its step, the step named fail fails, and closing
// records the closed document. Every other operation of the platform interface is not implemented by it.
type creationPlatform struct {
	platform.Platform
	fail   string
	steps  []string
	closed []unsafe.Pointer
}

func (p *creationPlatform) step(name string) error {
	p.steps = append(p.steps, name)
	if p.fail == name {
		return fmt.Errorf("%s failed", name)
	}
	return nil
}

func (p *creationPlatform) RestoreDocument(document unsafe.Pointer, state string) error {
	return p.step("restore")
}

func (p *creationPlatform) SetDocumentAppearance(document unsafe.Pointer, dark bool) {
	p.steps = append(p.steps, "appearance")
}

func (p *creationPlatform) SetDocumentBackground(document unsafe.Pointer, enabled bool) {
	p.steps = append(p.steps, "background")
}

func (p *creationPlatform) SetDocumentMessage(document unsafe.Pointer, message func(value string)) error {
	return p.step("message")
}

func (p *creationPlatform) SetDocumentStream(document unsafe.Pointer, stream func(value string)) error {
	return p.step("stream")
}

// SetDocumentStreamOn reports a refusal of native as false.
func (p *creationPlatform) SetDocumentStreamOn(document unsafe.Pointer, stream string, on bool) bool {
	return p.step("stream on") == nil
}

func (p *creationPlatform) SetDocumentEvent(document unsafe.Pointer, event func(value string)) error {
	return p.step("event")
}

func (p *creationPlatform) CloseDocument(document unsafe.Pointer) {
	p.closed = append(p.closed, document)
}

// useCreationPlatform makes fake the platform of the test.
func useCreationPlatform(t *testing.T, fake *creationPlatform) {
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
}

// creationSetup is the configuration of the region page of tab-1, with a restored history and the requests effect of its attach.
func creationSetup() documentSetup {
	return documentSetup{
		name:    "page",
		restore: "AAAA",
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

// contract: documents.create.failure-closes-document
func TestAFailedStepOfTheCreationClosesTheDocument(t *testing.T) {
	document := unsafe.Pointer(new(int))
	for _, fail := range creationSteps {
		fake := &creationPlatform{fail: fail}
		useCreationPlatform(t, fake)
		err := configureDocument(document, creationSetup())
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
		if !reflect.DeepEqual(fake.closed, []unsafe.Pointer{document}) {
			t.Fatalf("the failure of %s left the document open: closed %v", fail, fake.closed)
		}
		if want := stepsUntil(fail); !reflect.DeepEqual(fake.steps, want) {
			t.Fatalf("the failure of %s ran the steps %v, want %v", fail, fake.steps, want)
		}
	}
}

// contract: documents.create.failure-closes-document
func TestACreationWithoutFailureKeepsTheDocument(t *testing.T) {
	fake := &creationPlatform{}
	useCreationPlatform(t, fake)
	if err := configureDocument(unsafe.Pointer(new(int)), creationSetup()); err != nil {
		t.Fatal(err)
	}
	if want := stepsUntil(""); !reflect.DeepEqual(fake.steps, want) {
		t.Fatalf("steps %v, want %v", fake.steps, want)
	}
	if len(fake.closed) != 0 {
		t.Fatalf("a configured document was closed: %v", fake.closed)
	}
}

// documentAttachPlatform is the platform of the attach tests: it records the created documents on top of the creation steps.
type documentAttachPlatform struct {
	creationPlatform
	created []unsafe.Pointer
}

func (p *documentAttachPlatform) CreateDocument(surface unsafe.Pointer, options platform.DocumentOptions, changed func(string)) (unsafe.Pointer, error) {
	handle := unsafe.Pointer(new(int))
	p.created = append(p.created, handle)
	return handle, nil
}

// documentAttachSurfaces returns the surfaces of a window whose surface-a of the installed plugin probe declares the document
// region page. A task queued on the third value runs ahead of the next step of the main thread.
func documentAttachSurfaces(t *testing.T) (*Surfaces, *documentAttachPlatform, *queuedFramework) {
	t.Helper()
	config := t.TempDir()
	for name, content := range map[string]string{
		"plugins/installed.json":           `{"format": 3, "plugins": {"probe": {"version": "1.0.0", "path": "plugins/probe/1.0.0", "enabled": true, "sidecars": {}}}, "sidecars": {}}`,
		"plugins/probe/1.0.0/package.json": `{"name": "plugin-probe"}`,
		"plugins/probe/1.0.0/plugin.json":  `{"id": "probe"}`,
	} {
		file := filepath.Join(config, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	surfaces := &Surfaces{
		documents:      NewDocuments(),
		streams:        NewDocumentStreams(),
		host:           &Host{configDir: config},
		window:         &noticeFrontend{},
		views:          map[string]*nativeWebview{"surface-a": {handle: unsafe.Pointer(new(int))}},
		surfacePlugins: map[string]string{"surface-a": "probe"},
		compositions: map[string]SurfaceComposition{"surface-a": {Kind: "view", Regions: []SurfaceRegion{
			{Name: "page", Kind: "document"},
		}}},
	}
	fake, steps := &documentAttachPlatform{}, &queuedFramework{}
	savedSystem, savedFramework := system, framework
	system, framework = fake, steps
	t.Cleanup(func() { system, framework = savedSystem, savedFramework })
	return surfaces, fake, steps
}

// contract: documents.attach.one-main-step
func TestAReloadDuringADocumentAttachLeavesNoRegionWithoutAName(t *testing.T) {
	surfaces, fake, steps := documentAttachSurfaces(t)
	key, request := DocumentKey{Surface: "surface-a", Name: "page"}, DocumentRequest{Surface: "surface-a", Document: "page"}
	// The reload of the surface and the attach of its new page, which run on the main thread ahead of the main-thread work of the first attach.
	var attachedAgain error
	steps.queued = func() {
		surfaces.streams.RemoveSurface("surface-a")
		for _, handle := range surfaces.documents.RemoveSurface("surface-a") {
			system.CloseDocument(handle)
		}
		attachedAgain = surfaces.attachCheckedDocument(key, request)
	}
	if err := surfaces.attachCheckedDocument(key, request); err == nil {
		t.Fatal("two attaches of one name succeeded")
	}
	if attachedAgain != nil {
		t.Fatalf("the attach of the new page: %v", attachedAgain)
	}
	if len(fake.created) != 1 {
		t.Fatalf("the attaches created %d regions, one of them without a name", len(fake.created))
	}
	handle, err := surfaces.documents.Get(key)
	if err != nil || handle != fake.created[0] {
		t.Fatalf("the name holds %v (%v), the region of the new page is %v", handle, err, fake.created[0])
	}
}

// contract: documents.attach.one-main-step
func TestASurfaceCloseDuringADocumentAttachFindsNoNameOfTheAttach(t *testing.T) {
	surfaces, fake, steps := documentAttachSurfaces(t)
	key, request := DocumentKey{Surface: "surface-a", Name: "page"}, DocumentRequest{Surface: "surface-a", Document: "page"}
	var found []unsafe.Pointer
	steps.queued = func() {
		surfaces.streams.RemoveSurface("surface-a")
		found = surfaces.documents.RemoveSurface("surface-a")
		delete(surfaces.views, "surface-a")
		delete(surfaces.compositions, "surface-a")
	}
	if err := surfaces.attachCheckedDocument(key, request); err == nil {
		t.Fatal("the attach of a closed surface succeeded")
	}
	if len(fake.created) != 0 {
		t.Fatalf("the attach created %d regions in a closed surface", len(fake.created))
	}
	if len(found) != 0 {
		t.Fatalf("the close found %d names of an attach that holds them across the steps of the main thread", len(found))
	}
}

// contract: documents.attach.one-main-step
func TestAFailedDocumentAttachTakesBackItsNameAndItsRequestLog(t *testing.T) {
	surfaces, _, _ := documentAttachSurfaces(t)
	delete(surfaces.surfacePlugins, "surface-a")
	key, request := DocumentKey{Surface: "surface-a", Name: "page"}, DocumentRequest{Surface: "surface-a", Document: "page"}
	if err := surfaces.attachCheckedDocument(key, request); err == nil {
		t.Fatal("the attach of a surface without a plugin succeeded")
	}
	if err := surfaces.documents.Reserve(key); err != nil {
		t.Fatalf("the failed attach kept its name: %v", err)
	}
	if _, err := surfaces.streams.Attach(key); err != nil {
		t.Fatalf("the failed attach kept its request log: %v", err)
	}
}

// contract: documents.stream.interactive
func TestAnInteractiveSubscriptionTurnsTheStreamOnAndDeliversFoldedFrames(t *testing.T) {
	streams := NewDocumentStreams()
	key := DocumentKey{Surface: "surface-a", Name: "page"}
	handle, effects, initial, err := streams.Subscribe(key, "interactive")
	if err != nil {
		t.Fatalf("an interactive subscription was refused: %v", err)
	}
	if initial != nil {
		t.Fatalf("an interactive subscription holds an initial message %s of its own", initial)
	}
	want := []StreamEffect{{Key: key, Stream: "interactive", On: true}}
	if !reflect.DeepEqual(effects, want) {
		t.Fatalf("the first subscription of the interactive stream gave effects %v, want %v", effects, want)
	}
	frames := `{"stream":"interactive","message":{"type":"frames","seq":7,"frames":[],"framesTruncated":0,"viewport":{"w":800,"h":600},"scale":2}}`
	result, err := streams.Deliver(key, frames)
	if err != nil {
		t.Fatalf("a frames message was refused: %v", err)
	}
	if !result.Ack || result.Seq != 7 || len(result.Deliveries) != 1 {
		t.Fatalf("a frames message gave %+v, want one delivery and the acknowledgement of seq 7", result)
	}
	if _, err := streams.Deliver(key, `{"stream":"interactive","message":{"type":"frames","viewport":{"w":800,"h":600},"scale":2}}`); err == nil {
		t.Fatal("a frames message without a seq was accepted")
	}
	effects, err = streams.Unsubscribe(key, handle)
	if err != nil {
		t.Fatalf("the unsubscribe of the interactive stream: %v", err)
	}
	want = []StreamEffect{{Key: key, Stream: "interactive", On: false}}
	if !reflect.DeepEqual(effects, want) {
		t.Fatalf("the last unsubscribe of the interactive stream gave effects %v, want %v", effects, want)
	}
}
