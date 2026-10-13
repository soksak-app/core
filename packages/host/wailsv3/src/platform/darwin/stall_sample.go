//go:build darwin

package darwin

// The sample of a stall of the host on macOS: the system tool `sample` writes the stacks of every thread of this process.

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// SampleThreads writes the stacks of the threads of this process, sampled for one second, into path.
func (implementation) SampleThreads(path string) error {
	output, err := exec.Command("/usr/bin/sample", strconv.Itoa(os.Getpid()), "1", "-file", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("/usr/bin/sample: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}
