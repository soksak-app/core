package host_test

import (
	"os"
	"strings"
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// png 은 1x1 RGBA PNG 다. IHDR 의 CRC 는 0x1F15C489 다.
var png = []byte{
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
	0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
	0x42, 0x60, 0x82,
}

// contract: clipboard.persist-png.writes-exact-bytes, clipboard.persist-png.owner-only-mode, clipboard.png.accepts-valid-within-bound
func TestPersistClipboardPNGCreatesOwnedFile(t *testing.T) {
	path, err := host.PersistClipboardPNG(t.TempDir(), png)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(png) {
		t.Fatalf("saved %q", data)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
}

// contract: clipboard.png.rejects-bad-signature, clipboard.png.rejects-bad-header
func TestPersistClipboardPNGRequiresTheSignatureAndAValidHeader(t *testing.T) {
	if _, err := host.PersistClipboardPNG(t.TempDir(), []byte("png")); err == nil || !strings.Contains(err.Error(), "PNG signature") {
		t.Fatalf("bytes without the PNG signature: %v", err)
	}
	changed := func(change func([]byte)) []byte {
		bytes := append([]byte(nil), png...)
		change(bytes)
		return bytes
	}
	for name, bytes := range map[string][]byte{
		"truncated": png[:20],
		"chunk":     changed(func(b []byte) { b[12] = 'X' }),
		"crc":       changed(func(b []byte) { b[29] ^= 0xFF }),
		"width":     changed(func(b []byte) { copy(b[16:20], []byte{0, 0, 0, 0}) }),
		"depth":     changed(func(b []byte) { b[24] = 3 }),
	} {
		if _, err := host.PersistClipboardPNG(t.TempDir(), bytes); err == nil || !strings.Contains(err.Error(), "PNG header") {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

// contract: clipboard.png.rejects-oversize, clipboard.png.rejects-empty
func TestPersistClipboardPNGRejectsBounds(t *testing.T) {
	large := append(append([]byte(nil), png...), make([]byte, 16*1024*1024+1-len(png))...)
	if _, err := host.PersistClipboardPNG(t.TempDir(), large); err == nil {
		t.Fatal("expected size error")
	}
	if _, err := host.PersistClipboardPNG(t.TempDir(), []byte{}); err == nil {
		t.Fatal("expected empty payload error")
	}
}

// contract: clipboard.read.requires-user-initiated, clipboard.read.rejects-unknown-type, clipboard.read.accepts-known-types
func TestClipboardReadRequiresAnExplicitUserPasteAndAKnownType(t *testing.T) {
	for _, kind := range []string{"text", "fileURLs"} {
		if err := host.ValidateClipboardRead(kind, true); err != nil {
			t.Fatalf("user paste of %s rejected: %v", kind, err)
		}
	}
	if err := host.ValidateClipboardRead("text", false); err == nil {
		t.Fatal("a read without an explicit user paste was accepted")
	}
	if err := host.ValidateClipboardRead("unknown", true); err == nil {
		t.Fatal("an unknown clipboard type was accepted")
	}
}
