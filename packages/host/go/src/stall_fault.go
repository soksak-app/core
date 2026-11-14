//go:build diagnostics

// The fault injection point of the sample of a stall. It is compiled only with the diagnostics build tag; the release build has the
// no-op counterpart in stall_fault_release.go.

package host

import (
	"fmt"
	"io"
	"os"
)

// faultStallSample is the fault injection point of the sample of a stall. Its value is the path of a FIFO: the sample of the stall
// does not start until the FIFO has a writer and ends its wait when the writer closes the FIFO, so a sample lasts as long as the
// check holds the FIFO, as the sample of a loaded system lasts for seconds. docs/operations/examples.md#test-kinds
const faultStallSample = "SOKSAK_FAULT_STALL_SAMPLE"

// stallSampleFault holds the sample of a stall until the writer of the FIFO that the fault point names closes it, and returns nil
// at once when the point is not set.
func stallSampleFault() error {
	path := os.Getenv(faultStallSample)
	if path == "" {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("%s: %w", faultStallSample, err)
	}
	defer file.Close()
	if _, err := io.Copy(io.Discard, file); err != nil {
		return fmt.Errorf("%s: %w", faultStallSample, err)
	}
	return nil
}
