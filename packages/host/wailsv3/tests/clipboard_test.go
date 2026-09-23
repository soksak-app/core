package host_test

import (
	"os"
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// contract: clipboard.persist-png.writes-exact-bytes, clipboard.persist-png.owner-only-mode, clipboard.png.accepts-nonempty-within-bound
func TestPersistClipboardPNGCreatesOwnedFile(t *testing.T) {
	path, err := host.PersistClipboardPNG(t.TempDir(), []byte("png"))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "png" {
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

// contract: clipboard.png.rejects-oversize
func TestPersistClipboardPNGRejectsBounds(t *testing.T) {
	if _, err := host.PersistClipboardPNG(t.TempDir(), make([]byte, 16*1024*1024+1)); err == nil {
		t.Fatal("expected size error")
	}
}
