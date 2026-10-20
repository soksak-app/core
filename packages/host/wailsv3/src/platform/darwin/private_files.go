//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// CreatePrivateDirectories creates the missing directories of path with mode 0700. It does not change the permissions of a directory
// that already exists.
func (implementation) CreatePrivateDirectories(path string) error {
	return os.MkdirAll(path, 0o700)
}

// AppendPrivateFile opens the file at path for appending. When it does not exist, it creates it with mode 0600. It does not change the permissions of an existing
// file.
func (implementation) AppendPrivateFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

// CreatePrivateFile creates a new file at path with mode 0600 and opens it for writing. When path already exists, the error is
// os.ErrExist.
func (implementation) CreatePrivateFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
}

// OpenPrivateFile opens the existing file at path for reading and writing. A missing file is an os.ErrNotExist error. Its contents and
// permissions are not changed.
func (implementation) OpenPrivateFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDWR, 0)
}

// TryLockFile takes flock(LOCK_EX|LOCK_NB) on file. A lock held by another open file is reported as false, not as an error.
func (implementation) TryLockFile(file *os.File) (bool, error) {
	err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("%s cannot be locked: %w", file.Name(), err)
	}
	return true, nil
}

// IsNamedFile reports whether file is the file that path names now. A missing path names no file.
func (implementation) IsNamedFile(file *os.File, path string) (bool, error) {
	opened, err := file.Stat()
	if err != nil {
		return false, err
	}
	named, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return os.SameFile(opened, named), nil
}

// WritePrivateFile replaces the content of the file at path with data. When it does not exist, it creates it with mode 0600. It does not change the permissions of an existing
// file.
func (implementation) WritePrivateFile(path string, data []byte) error {
	return os.WriteFile(path, data, 0o600)
}

// SecureServiceDirectory changes the permissions of the persistent service directory path to 0700.
func (implementation) SecureServiceDirectory(path string) error {
	return os.Chmod(path, 0o700)
}

// PrivateDirectory makes path a directory that only the current user can access and, when it already exists, checks the kind, the owner and
// the permissions.
func (implementation) PrivateDirectory(path string) error {
	return privateDirectory(path)
}
