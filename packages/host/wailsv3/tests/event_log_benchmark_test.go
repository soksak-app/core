// The cost of `EventLog.Emit` on the calling goroutine, alone and with several producers, against a writer that drains
// at its own pace. The numbers are measured, not asserted (docs/spec/logging.md#writers).
package host_test

import (
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

type benchmarkFields struct {
	KeyCode    uint32 `json:"key_code"`
	Characters string `json:"characters"`
}

func summary(name string, samples []int64) string {
	sort.Slice(samples, func(a, b int) bool { return samples[a] < samples[b] })
	var sum int64
	for _, sample := range samples {
		sum += sample
	}
	return fmt.Sprintf("%-42s mean %7d ns  p50 %7d ns  p99 %7d ns  max %9d ns", name, sum/int64(len(samples)),
		samples[len(samples)/2], samples[len(samples)*99/100], samples[len(samples)-1])
}

// BenchmarkEventLogEmit reports the cost of one Emit for 1, 4 and 8 producers.
func BenchmarkEventLogEmit(b *testing.B) {
	log, err := host.StartEventLog(host.EventLogOptions{
		Directory: b.TempDir(), Role: "bench", Boot: "b1", QueueEvents: 1 << 16, QueueBytes: 64 << 20,
		BatchInterval: 100 * time.Millisecond, RotateBytes: 100 << 20, RetentionBytes: 6 << 30,
	})
	if err != nil {
		b.Fatal(err)
	}
	defer log.Close()
	for _, producers := range []int{1, 4, 8} {
		var group sync.WaitGroup
		results := make([][]int64, producers)
		lost := make([]int, producers)
		for index := 0; index < producers; index++ {
			group.Add(1)
			go func(index int) {
				defer group.Done()
				samples := make([]int64, 0, 100_000)
				for len(samples) < 100_000 {
					start := time.Now()
					accepted := log.Emit(host.LevelInfo, "host.bench.event", benchmarkFields{KeyCode: 36, Characters: "\r"})
					samples = append(samples, time.Since(start).Nanoseconds())
					if !accepted {
						lost[index]++
					}
				}
				results[index] = samples
			}(index)
		}
		group.Wait()
		var all []int64
		total := 0
		for index := range results {
			all = append(all, results[index]...)
			total += lost[index]
		}
		b.Log(summary(fmt.Sprintf("emit, %d producer(s) (lost %d)", producers, total), all))
	}
	if err := log.Flush(30 * time.Second); err != nil {
		b.Fatal(err)
	}
}
