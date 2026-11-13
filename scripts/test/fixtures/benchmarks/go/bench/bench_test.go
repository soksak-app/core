package bench

import (
	"testing"
	"time"
)

// TestAlpha is a test, which the benchmark listing skips.
func TestAlpha(t *testing.T) {}

// BenchmarkEventLogEmit finishes at once.
func BenchmarkEventLogEmit(b *testing.B) {
	for i := 0; i < b.N; i++ {
	}
}

// BenchmarkNativePull runs longer than the limit of the test, so the runner kills it.
func BenchmarkNativePull(b *testing.B) {
	time.Sleep(30 * time.Second)
}
