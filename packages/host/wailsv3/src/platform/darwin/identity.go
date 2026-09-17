//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"syscall"
)

// DirectoryIdentity 는 장치 번호와 inode 번호로 디렉터리를 식별한다.
func (implementation) DirectoryIdentity(_ string, info os.FileInfo) (string, error) {
	stat := info.Sys().(*syscall.Stat_t)
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}
