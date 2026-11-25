package host

import (
	"fmt"
	"sync"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// imageGenerationCounter issues the generations of the image attachments of the process. A persistent supplier outlives the
// application process and keeps the generation of each surface, and a surface moves between windows, so every window of the
// process takes its generations from this one counter, and each generation is the larger of the previous one plus 1 and the
// boot clock of the platform in microseconds (docs/spec/surface-composition.md).
type imageGenerationCounter struct {
	mu   sync.Mutex
	last uint64
}

var imageGenerations imageGenerationCounter

func (c *imageGenerationCounter) next() uint64 {
	// The platform of a running host implements the clock, because a host that misses an operation of its platform fails at
	// startup (docs/spec/hosts.md); a failure here is a defect of the platform, which ends the process with an error record.
	system, err := platform.Current()
	var nanos uint64
	if err == nil {
		nanos, err = system.MonotonicNanos()
	}
	if err != nil {
		fatalError("image generation", fmt.Sprintf("the boot clock cannot be read: %v", err))
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.last = max(c.last+1, nanos/1000)
	return c.last
}
