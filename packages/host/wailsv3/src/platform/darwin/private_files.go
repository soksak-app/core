//go:build darwin

package darwin

import "os"

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
