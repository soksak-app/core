//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"syscall"
)

func (implementation) ReplaceStandardError(file *os.File) error {
	if err := syscall.Dup2(int(file.Fd()), int(os.Stderr.Fd())); err != nil {
		return fmt.Errorf("replace standard error: %w", err)
	}
	return nil
}
