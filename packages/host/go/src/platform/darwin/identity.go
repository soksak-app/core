//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"regexp"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// directoryIdentityPattern is the form that DirectoryIdentity returns: the uppercase hyphenated UUID, a colon and the decimal inode.
var directoryIdentityPattern = regexp.MustCompile(`^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}:[0-9]+$`)

// DirectoryIdentityForm names the form that DirectoryIdentity returns.
func (implementation) DirectoryIdentityForm() string {
	return "<volume UUID>:<inode>"
}

// ValidDirectoryIdentity reports whether identity has the form that DirectoryIdentity returns.
func (implementation) ValidDirectoryIdentity(identity string) bool {
	return directoryIdentityPattern.MatchString(identity)
}

// DirectoryIdentity identifies a directory by the UUID of its volume and its inode number: `<volume UUID>:<inode>`. The device
// number st_dev does not identify a volume across boots, because the system renumbers it at each boot, and statfs f_fsid is the
// same device number. getattrlist with ATTR_VOL_UUID returns the UUID that the volume stores, which stays the same across boots
// and remounts. golang.org/x/sys/unix declares the attribute list and the constants for darwin but no getattrlist function, so
// the call runs through the system call number, as WaitProcessExit does for waitid.
func (implementation) DirectoryIdentity(path string, info os.FileInfo) (string, error) {
	stat := info.Sys().(*syscall.Stat_t)
	name, err := syscall.BytePtrFromString(path)
	if err != nil {
		return "", fmt.Errorf("project directory volume UUID cannot be read: %s (%v)", path, err)
	}
	list := unix.Attrlist{Bitmapcount: unix.ATTR_BIT_MAP_COUNT, Volattr: unix.ATTR_VOL_INFO | unix.ATTR_VOL_UUID}
	// The reply is the length of the reply as a uint32 followed by the 16 bytes of the UUID.
	var reply [4 + 16]byte
	if _, _, errno := unix.Syscall6(unix.SYS_GETATTRLIST, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&list)),
		uintptr(unsafe.Pointer(&reply[0])), uintptr(len(reply)), 0, 0); errno != 0 {
		return "", fmt.Errorf("project directory volume UUID cannot be read: %s (errno %d)", path, int(errno))
	}
	id := reply[4:]
	return fmt.Sprintf("%02X%02X%02X%02X-%02X%02X-%02X%02X-%02X%02X-%02X%02X%02X%02X%02X%02X:%d",
		id[0], id[1], id[2], id[3], id[4], id[5], id[6], id[7], id[8], id[9], id[10], id[11], id[12], id[13], id[14], id[15], stat.Ino), nil
}
