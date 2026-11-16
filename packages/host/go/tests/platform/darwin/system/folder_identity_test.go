//go:build darwin

package system_test

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// volumeUUID reads the UUID of the volume that holds path from the system tools df and diskutil, which are independent of the host.
func volumeUUID(t *testing.T, path string) string {
	t.Helper()
	listing, err := exec.Command("df", "-P", path).Output()
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(listing)), "\n")
	fields := strings.Fields(lines[len(lines)-1])
	mount := strings.Join(fields[5:], " ")
	info, err := exec.Command("diskutil", "info", mount).Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(info), "\n") {
		if value, found := strings.CutPrefix(strings.TrimSpace(line), "Volume UUID:"); found {
			return strings.TrimSpace(value)
		}
	}
	t.Fatalf("diskutil reported no volume UUID for %s", mount)
	return ""
}

// contract: workspace.folder.identity-names-volume-uuid
func TestFolderIdentityNamesVolumeUUID(t *testing.T) {
	root := t.TempDir()
	folder, err := host.ResolveProjectFolder(root)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(folder.Root)
	if err != nil {
		t.Fatal(err)
	}
	inode := info.Sys().(*syscall.Stat_t).Ino
	want := volumeUUID(t, folder.Root) + ":" + strconv.FormatUint(inode, 10)
	if folder.Identity != want {
		t.Fatalf("identity %q, want <volume UUID>:<inode> %q", folder.Identity, want)
	}
}
