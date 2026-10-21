package host

import (
	"errors"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// binaryPlatform is the platform of the binary take tests. It keeps the bytes of each id, and a take releases the id as the native
// layer does.
type binaryPlatform struct {
	platform.Platform
	stored map[string][]byte
}

func (p *binaryPlatform) TakeDocumentBinary(document unsafe.Pointer, id string) ([]byte, error) {
	bytes, ok := p.stored[id]
	if !ok {
		return nil, errors.New("the binary id is not stored")
	}
	delete(p.stored, id)
	return bytes, nil
}

const takenID = "0123456789abcdef0123456789abcdef"

// contract: documents.binary.take-releases-id
// A take returns the bytes of the id of the document and releases the id, so a second take of the id gives the native error text.
func TestTakeReturnsTheBytesOfTheIdAndReleasesIt(t *testing.T) {
	fake := &binaryPlatform{stored: map[string][]byte{takenID: []byte("png-bytes")}}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{documents: NewDocuments()}
	key := DocumentKey{Surface: "probe-surface", Name: "doc"}
	if err := s.documents.Reserve(key); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	s.documents.Set(key, unsafe.Pointer(new(int)))
	got, err := s.takeDocumentBinary("probe-surface", "doc", takenID)
	if err != nil || string(got) != "png-bytes" {
		t.Fatalf("take returned %q, %v; want the stored bytes", got, err)
	}
	_, err = s.takeDocumentBinary("probe-surface", "doc", takenID)
	if err == nil || err.Error() != "the binary id is not stored" {
		t.Fatalf("second take returned %v; want the native error text", err)
	}
}

// contract: documents.binary.take-errors
// A take of a document that is not attached gives the error text that the document operations give.
func TestTakeOfAMissingDocumentGivesTheDocumentErrorText(t *testing.T) {
	s := &Surfaces{documents: NewDocuments()}
	_, err := s.takeDocumentBinary("probe-surface", "doc", takenID)
	if err == nil || err.Error() != `document "doc" is not attached` {
		t.Fatalf("take of a missing document returned %v; want the document error text", err)
	}
}
