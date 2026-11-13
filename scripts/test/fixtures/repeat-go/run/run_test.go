package run

import (
	"testing"
	"time"
)

func TestAlpha(t *testing.T) {}

// sleepInFixture holds the goroutine of TestBeta past its limit, so the testing package ends the test at its -test.timeout.
func sleepInFixture() { time.Sleep(8 * time.Second) }

func TestBeta(t *testing.T) { sleepInFixture() }

func BenchmarkGamma(b *testing.B) {
	for i := 0; i < b.N; i++ {
	}
}
