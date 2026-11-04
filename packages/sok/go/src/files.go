package sok

// Wording of file errors (docs/spec/cli.md). The two implementations report the same failure with the same wording.

import (
	"errors"
	"fmt"
	"io/fs"
	"syscall"
)

// fileError writes the failure of a file operation on path as "<path>: <reason>". The reason is the operating system
// error text and starts with a lowercase letter. It wraps the original error, so checks such as errors.Is(err,
// fs.ErrNotExist) keep working.
func fileError(path string, err error) error {
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		err = pathErr.Err
	}
	return fmt.Errorf("%s: %w", path, err)
}

// osReason is the reason text of an operating system error. For a system call error it is that text; otherwise it is
// the error text itself.
func osReason(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno.Error()
	}
	return err.Error()
}

// withCleanup removes with remove the temporary path that a failed operation left. When the removal fails, it appends
// that failure to the original error as "; cleanup <path>: <reason>". A path that no longer exists leaves nothing, so
// it counts as removed.
func withCleanup(err error, temp string, remove func(string) error) error {
	if cleanupErr := remove(temp); cleanupErr != nil && !errors.Is(cleanupErr, fs.ErrNotExist) {
		return fmt.Errorf("%w; cleanup %w", err, fileError(temp, cleanupErr))
	}
	return err
}
