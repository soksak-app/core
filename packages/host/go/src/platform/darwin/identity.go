//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"syscall"
)

// DirectoryIdentity identifies a directory by the device number and the inode number.
func (implementation) DirectoryIdentity(_ string, info os.FileInfo) (string, error) {
	stat := info.Sys().(*syscall.Stat_t)
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}
