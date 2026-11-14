//go:build darwin

package darwin

// The login shell of the user is the pw_shell member of the user database entry of the user id (getpwuid_r of pwd.h). The
// module runs without cgo, and neither os/user, which has no shell member, nor golang.org/x/sys/unix reads that member, so the
// function of libSystem is called through purego.

import (
	"fmt"
	"os"
	"sync"
	"syscall"
	"unicode/utf8"
	"unsafe"

	"github.com/ebitengine/purego"
)

// passwd is struct passwd of pwd.h of the macOS SDK.
type passwd struct {
	name, password *byte
	uid, gid       uint32
	change         int64
	class, gecos   *byte
	dir, shell     *byte
	expire         int64
}

var (
	getpwuidR     func(uid uint32, entry *passwd, buffer *byte, size uintptr, result **passwd) int32
	getpwuidROnce sync.Once
	getpwuidRErr  error
)

// LoginShell returns pw_shell of the user database entry of the user of this process.
func (implementation) LoginShell() (string, error) {
	getpwuidROnce.Do(func() {
		library, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			getpwuidRErr = fmt.Errorf("login shell: %w", err)
			return
		}
		purego.RegisterLibFunc(&getpwuidR, library, "getpwuid_r")
	})
	if getpwuidRErr != nil {
		return "", getpwuidRErr
	}
	uid := uint32(os.Getuid())
	for size := 1024; ; size *= 2 {
		var entry passwd
		var result *passwd
		buffer := make([]byte, size)
		code := getpwuidR(uid, &entry, &buffer[0], uintptr(size), &result)
		if syscall.Errno(code) == syscall.ERANGE && size < 1<<20 {
			continue
		}
		if code != 0 {
			return "", fmt.Errorf("getpwuid_r for uid %d: errno %d", uid, code)
		}
		if result == nil {
			return "", fmt.Errorf("the user database has no entry for uid %d", uid)
		}
		shell := cString(entry.shell)
		if shell == "" {
			return "", fmt.Errorf("the user database names no login shell for uid %d", uid)
		}
		if !utf8.ValidString(shell) {
			return "", fmt.Errorf("the login shell of uid %d is not valid UTF-8", uid)
		}
		return shell, nil
	}
}

// cString is the text of a NUL-terminated string.
func cString(text *byte) string {
	if text == nil {
		return ""
	}
	length := 0
	for *(*byte)(unsafe.Add(unsafe.Pointer(text), length)) != 0 {
		length++
	}
	return string(unsafe.Slice(text, length))
}
