package host

import (
	"os"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// viewPNG is a 1x1 RGBA PNG: its signature and IHDR, which the persist checks, and the bytes that follow.
var viewPNG = []byte{
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
	0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
	0x00, 0x1F, 0x15, 0xC4, 0x89,
}

// binaryViewProbe attaches a real view to a real surface of a real window, whose native document holds the binary store that the tests
// of this file put into and take from.
func binaryViewProbe(t *testing.T) *viewProbe {
	t.Helper()
	return realViewProbe(t, Theme{Scheme: "dark", Tokens: map[string]string{"bg": "#000000"}}, nullOriginStart())
}

// putBinary puts bytes into the store of the view of probe-surface on the main thread.
func (p *viewProbe) putBinary(bytes []byte, contentType string) (string, error) {
	var id string
	var err error
	runOnMainThread(func() { id, err = p.s.putViewBinary("probe-surface", bytes, contentType) })
	return id, err
}

// takeBinary takes the bytes of id from the store of the view of surface on the main thread.
func (p *viewProbe) takeBinary(surface, id string) ([]byte, error) {
	var bytes []byte
	var err error
	runOnMainThread(func() { bytes, err = p.s.takeViewBinary(surface, id) })
	return bytes, err
}

// contract: documents.binary.view-take-releases-id
// A take returns the bytes of the id of the view and releases the id, so a second take of the id gives the native error text.
func TestViewTakeReturnsTheBytesOfTheIdAndReleasesIt(t *testing.T) {
	p := binaryViewProbe(t)
	id, err := p.putBinary([]byte("png-bytes"), "image/png")
	if err != nil {
		t.Fatalf("put returned %v", err)
	}
	got, err := p.takeBinary("probe-surface", id)
	if err != nil || string(got) != "png-bytes" {
		t.Fatalf("take returned %q, %v; want the stored bytes", got, err)
	}
	_, err = p.takeBinary("probe-surface", id)
	if err == nil || err.Error() != "the binary id is not stored" {
		t.Fatalf("second take returned %v; want the native error text", err)
	}
}

// contract: documents.binary.view-put-mints-id
// A put stores the bytes with their content type in the store of the view and returns the id that the native put mints, and a refusal
// of the native put is passed on. The content type that the store keeps is answered by its binary path to the page of the view, which
// native/darwin/tests/document_binary_test.m reads; the platform interface returns only the bytes.
func TestViewPutStoresTheBytesUnderTheMintedId(t *testing.T) {
	p := binaryViewProbe(t)
	first, err := p.putBinary([]byte("png-bytes"), "image/png")
	if err != nil || len(first) != 32 {
		t.Fatalf("put returned %q, %v; want a minted id of 32 characters", first, err)
	}
	second, err := p.putBinary([]byte("other-bytes"), "image/png")
	if err != nil || second == first {
		t.Fatalf("second put returned %q, %v; want an id other than %q", second, err, first)
	}
	if got, err := p.takeBinary("probe-surface", first); err != nil || string(got) != "png-bytes" {
		t.Fatalf("take of the first id returned %q, %v; want the bytes of the first put", got, err)
	}
	if got, err := p.takeBinary("probe-surface", second); err != nil || string(got) != "other-bytes" {
		t.Fatalf("take of the second id returned %q, %v; want the bytes of the second put", got, err)
	}
	if _, err := p.putBinary(nil, "image/png"); err == nil || err.Error() != "the put holds no bytes" {
		t.Fatalf("an empty put returned %v; want the native error text", err)
	}
}

// contract: documents.binary.view-errors
// A take or a put for a surface without a view gives the error that names the surface and changes no store.
func TestViewBinaryOfASurfaceWithoutAViewGivesTheSurfaceError(t *testing.T) {
	p := binaryViewProbe(t)
	id, err := p.putBinary([]byte("png-bytes"), "image/png")
	if err != nil {
		t.Fatalf("put returned %v", err)
	}
	if _, err := p.takeBinary("other-surface", id); err == nil || err.Error() != `surface "other-surface" has no view` {
		t.Fatalf("take of a surface without a view returned %v; want the surface error", err)
	}
	var putErr error
	runOnMainThread(func() { _, putErr = p.s.putViewBinary("other-surface", []byte("png-bytes"), "image/png") })
	if putErr == nil || putErr.Error() != `surface "other-surface" has no view` {
		t.Fatalf("put of a surface without a view returned %v; want the surface error", putErr)
	}
	if got, err := p.takeBinary("probe-surface", id); err != nil || string(got) != "png-bytes" {
		t.Fatalf("take after the refusals returned %q, %v; want the store unchanged with the stored bytes", got, err)
	}
	if _, err := p.takeBinary("probe-surface", id); err == nil || err.Error() != "the binary id is not stored" {
		t.Fatalf("second take returned %v; the store held an id that the refusals did not put", err)
	}
}

// contract: clipboard.view.read-png-puts-binary
// A PNG read for a view puts the PNG of the clipboard into the store of the view as image/png and answers a present PNG that the id
// names; a clipboard without a PNG answers that no PNG is present and puts nothing, and a PNG over the limit is refused and puts nothing.
// The value of the clipboard is data, because the real clipboard is the pasteboard of the person; the put goes through the real store of
// the view. The content type that the store keeps is read by native/darwin/tests/document_binary_test.m.
func TestViewPNGReadAnswersFromTheValueOfTheClipboard(t *testing.T) {
	p := binaryViewProbe(t)
	put := func(value platform.ClipboardValue) (ClipboardViewReadResponse, error) {
		var answer ClipboardViewReadResponse
		var err error
		runOnMainThread(func() { answer, err = p.s.putViewPNG("probe-surface", value) })
		return answer, err
	}
	answer, err := put(platform.ClipboardValue{Present: true, Type: "png", PNG: viewPNG})
	if err != nil || !answer.Present || answer.Type != "png" || len(answer.Binary) != 32 {
		t.Fatalf("the answer for a clipboard with a PNG is %+v, %v; want a present PNG with the id of the put", answer, err)
	}
	if got, err := p.takeBinary("probe-surface", answer.Binary); err != nil || string(got) != string(viewPNG) {
		t.Fatalf("the store holds %q, %v under the id; want the PNG of the clipboard", got, err)
	}
	absent, err := put(platform.ClipboardValue{Present: false})
	if err != nil || absent != (ClipboardViewReadResponse{Present: false, Type: "png"}) {
		t.Fatalf("the answer for a clipboard without a PNG is %+v, %v; want an absent PNG without an id", absent, err)
	}
	atLimit, err := put(platform.ClipboardValue{Present: true, Type: "png", PNG: make([]byte, clipboardMaxBytes)})
	if err != nil || !atLimit.Present || len(atLimit.Binary) != 32 {
		t.Fatalf("the answer for a PNG at the limit is %+v, %v; want a present PNG with the id of the put", atLimit, err)
	}
	if got, err := p.takeBinary("probe-surface", atLimit.Binary); err != nil || len(got) != clipboardMaxBytes {
		t.Fatalf("the store holds %d bytes, %v under the id of the PNG at the limit; want %d", len(got), err, clipboardMaxBytes)
	}
	over, err := put(platform.ClipboardValue{Present: true, Type: "png", PNG: make([]byte, clipboardMaxBytes+1)})
	if err == nil || err.Error() != "clipboard PNG exceeds 16 MiB" || over.Binary != "" {
		t.Fatalf("the answer for a PNG over the limit is %+v, %v; want the error %q and no id", over, err, "clipboard PNG exceeds 16 MiB")
	}
}

// contract: clipboard.view.persist-png-takes-binary
// A persist of the PNG of a view takes the bytes of the id from the store of the view, which releases the id, and saves them; an id
// that is not stored gives the native take error.
func TestViewPNGPersistTakesTheIdAndSavesItsBytes(t *testing.T) {
	p := binaryViewProbe(t)
	id, err := p.putBinary(viewPNG, "image/png")
	if err != nil {
		t.Fatalf("put returned %v", err)
	}
	var path string
	runOnMainThread(func() { path, err = p.s.persistViewPNG(t.TempDir(), "probe-surface", id) })
	if err != nil {
		t.Fatalf("persist returned %v", err)
	}
	saved, err := os.ReadFile(path)
	if err != nil || string(saved) != string(viewPNG) {
		t.Fatalf("the saved file holds %q, %v; want the taken PNG", saved, err)
	}
	runOnMainThread(func() { _, err = p.s.persistViewPNG(t.TempDir(), "probe-surface", id) })
	if err == nil || err.Error() != "the binary id is not stored" {
		t.Fatalf("persist of a released id returned %v; want the native take error", err)
	}
}
