// The cost of the pull of the native ring across cgo (docs/spec/logging.md#writers): one call of the platform with an empty
// ring, which is the cost of every idle batch interval of the writer. The numbers are measured, not asserted.
package host_test

import (
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

func percentilesOf(samples []int64) string {
	sort.Slice(samples, func(a, b int) bool { return samples[a] < samples[b] })
	var sum int64
	for _, sample := range samples {
		sum += sample
	}
	return fmt.Sprintf("mean %6d ns  p50 %6d ns  p99 %6d ns  max %8d ns", sum/int64(len(samples)),
		samples[len(samples)/2], samples[len(samples)*99/100], samples[len(samples)-1])
}

// BenchmarkNativePull reports the cost of one pull and one loss read of an empty native ring across cgo.
func BenchmarkNativePull(b *testing.B) {
	system, err := platform.Current()
	if err != nil {
		b.Fatal(err)
	}
	buffer := make([]byte, 256<<10)
	pulls := make([]int64, 0, 100_000)
	losses := make([]int64, 0, 100_000)
	for len(pulls) < 100_000 {
		start := time.Now()
		if _, err := system.PullNativeEvents(buffer); err != nil {
			b.Fatal(err)
		}
		pulls = append(pulls, time.Since(start).Nanoseconds())
		start = time.Now()
		if _, _, err := system.TakeNativeEventLoss(0); err != nil {
			b.Fatal(err)
		}
		losses = append(losses, time.Since(start).Nanoseconds())
	}
	b.Log("pull of an empty ring across cgo        " + percentilesOf(pulls))
	b.Log("loss read of an empty ring across cgo   " + percentilesOf(losses))
}
