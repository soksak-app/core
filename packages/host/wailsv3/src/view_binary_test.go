package host

import (
	"errors"
	"fmt"
	"os"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// storedBinary is one id of the binary store of the fake platform: its bytes and their content type.
type storedBinary struct {
	bytes       []byte
	contentType string
}

// viewBinaryPlatform is the platform of the view binary tests. It keeps the bytes of each id of the view store; a take releases the
// id as the native layer does, and a put mints the next id. The clipboard holds png, or no PNG when png is nil.
type viewBinaryPlatform struct {
	platform.Platform
	stored map[string]storedBinary
	png    []byte
	puts   int
}

func (p *viewBinaryPlatform) TakeDocumentBinary(document unsafe.Pointer, id string) ([]byte, error) {
	entry, ok := p.stored[id]
	if !ok {
		return nil, errors.New("the binary id is not stored")
	}
	delete(p.stored, id)
	return entry.bytes, nil
}

func (p *viewBinaryPlatform) PutDocumentBinary(document unsafe.Pointer, bytes []byte, contentType string) (string, error) {
	if len(bytes) == 0 {
		return "", errors.New("the put holds no bytes")
	}
	p.puts++
	id := fmt.Sprintf("%032x", p.puts)
	p.stored[id] = storedBinary{bytes: append([]byte(nil), bytes...), contentType: contentType}
	return id, nil
}

func (p *viewBinaryPlatform) ClipboardRead(kind string) (platform.ClipboardValue, error) {
	if kind != "png" {
		return platform.ClipboardValue{}, fmt.Errorf("the view PNG read reads %q", kind)
	}
	if p.png == nil {
		return platform.ClipboardValue{Present: false}, nil
	}
	return platform.ClipboardValue{Present: true, Type: "png", PNG: p.png}, nil
}

const takenID = "0123456789abcdef0123456789abcdef"

// viewPNG is a 1x1 RGBA PNG: its signature and IHDR, which the persist checks, and the bytes that follow.
var viewPNG = []byte{
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
	0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
	0x00, 0x1F, 0x15, 0xC4, 0x89,
}

// viewSurfaces returns the surfaces of a window whose surface probe-surface has a view, with fake as the platform.
func viewSurfaces(t *testing.T, fake *viewBinaryPlatform) *Surfaces {
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{documents: NewDocuments()}
	s.documents.registerView("probe-surface", "probe", 1, unsafe.Pointer(new(int)))
	return s
}

// contract: documents.binary.view-take-releases-id
// A take returns the bytes of the id of the view and releases the id, so a second take of the id gives the native error text.
func TestViewTakeReturnsTheBytesOfTheIdAndReleasesIt(t *testing.T) {
	fake := &viewBinaryPlatform{stored: map[string]storedBinary{takenID: {bytes: []byte("png-bytes"), contentType: "image/png"}}}
	s := viewSurfaces(t, fake)
	got, err := s.takeViewBinary("probe-surface", takenID)
	if err != nil || string(got) != "png-bytes" {
		t.Fatalf("take returned %q, %v; want the stored bytes", got, err)
	}
	_, err = s.takeViewBinary("probe-surface", takenID)
	if err == nil || err.Error() != "the binary id is not stored" {
		t.Fatalf("second take returned %v; want the native error text", err)
	}
}

// contract: documents.binary.view-put-mints-id
// A put stores the bytes with their content type in the store of the view and returns the id that the native put mints, and a refusal
// of the native put is passed on.
func TestViewPutStoresTheBytesUnderTheMintedId(t *testing.T) {
	fake := &viewBinaryPlatform{stored: map[string]storedBinary{}}
	s := viewSurfaces(t, fake)
	id, err := s.putViewBinary("probe-surface", []byte("png-bytes"), "image/png")
	if err != nil || id != fmt.Sprintf("%032x", 1) {
		t.Fatalf("put returned %q, %v; want the minted id", id, err)
	}
	if entry := fake.stored[id]; string(entry.bytes) != "png-bytes" || entry.contentType != "image/png" {
		t.Fatalf("the store holds %q with %q; want the bytes with image/png", entry.bytes, entry.contentType)
	}
	if _, err := s.putViewBinary("probe-surface", nil, "image/png"); err == nil || err.Error() != "the put holds no bytes" {
		t.Fatalf("an empty put returned %v; want the native error text", err)
	}
}

// contract: documents.binary.view-errors
// A take or a put for a surface without a view gives the error that names the surface.
func TestViewBinaryOfASurfaceWithoutAViewGivesTheSurfaceError(t *testing.T) {
	fake := &viewBinaryPlatform{stored: map[string]storedBinary{takenID: {bytes: []byte("png-bytes")}}}
	s := viewSurfaces(t, fake)
	if _, err := s.takeViewBinary("other-surface", takenID); err == nil || err.Error() != `surface "other-surface" has no view` {
		t.Fatalf("take of a surface without a view returned %v; want the surface error", err)
	}
	if _, err := s.putViewBinary("other-surface", []byte("png-bytes"), "image/png"); err == nil ||
		err.Error() != `surface "other-surface" has no view` {
		t.Fatalf("put of a surface without a view returned %v; want the surface error", err)
	}
	if len(fake.stored) != 1 || fake.puts != 0 {
		t.Fatalf("the store changed: %d ids, %d puts", len(fake.stored), fake.puts)
	}
}

// contract: clipboard.view.read-png-puts-binary
// A PNG read for a view puts the PNG of the clipboard into the store of the view as image/png and answers its id; a clipboard without a
// PNG answers that no PNG is present and puts nothing.
func TestViewPNGReadPutsTheClipboardPNGIntoTheViewStore(t *testing.T) {
	fake := &viewBinaryPlatform{stored: map[string]storedBinary{}, png: viewPNG}
	s := viewSurfaces(t, fake)
	read, err := s.readViewPNG("probe-surface")
	if err != nil || !read.Present || read.Type != "png" || read.Binary != fmt.Sprintf("%032x", 1) {
		t.Fatalf("read returned %+v, %v; want the present PNG with the minted id", read, err)
	}
	if entry := fake.stored[read.Binary]; string(entry.bytes) != string(viewPNG) || entry.contentType != "image/png" {
		t.Fatalf("the store holds %q with %q; want the clipboard PNG as image/png", entry.bytes, entry.contentType)
	}
	fake.png = nil
	absent, err := s.readViewPNG("probe-surface")
	if err != nil || absent.Present || absent.Type != "png" || absent.Binary != "" || fake.puts != 1 {
		t.Fatalf("read of a clipboard without a PNG returned %+v, %v with %d puts; want an absent PNG and no put", absent, err, fake.puts)
	}
}

// contract: clipboard.view.persist-png-takes-binary
// A persist of the PNG of a view takes the bytes of the id from the store of the view and saves them, and an id that is not stored gives
// the native take error.
func TestViewPNGPersistTakesTheIdAndSavesItsBytes(t *testing.T) {
	fake := &viewBinaryPlatform{stored: map[string]storedBinary{takenID: {bytes: viewPNG, contentType: "image/png"}}}
	s := viewSurfaces(t, fake)
	path, err := s.persistViewPNG(t.TempDir(), "probe-surface", takenID)
	if err != nil {
		t.Fatalf("persist returned %v", err)
	}
	saved, err := os.ReadFile(path)
	if err != nil || string(saved) != string(viewPNG) {
		t.Fatalf("the saved file holds %q, %v; want the taken PNG", saved, err)
	}
	if _, ok := fake.stored[takenID]; ok {
		t.Fatal("the persist left the id in the store")
	}
	if _, err := s.persistViewPNG(t.TempDir(), "probe-surface", takenID); err == nil || err.Error() != "the binary id is not stored" {
		t.Fatalf("persist of a released id returned %v; want the native take error", err)
	}
}
