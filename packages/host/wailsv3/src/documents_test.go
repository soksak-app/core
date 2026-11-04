package host

import (
	"fmt"
	"reflect"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
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
