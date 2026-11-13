package linked

import "testing"

// BenchmarkEventLogEmit calls the C function, so the test binary links the object of value.c.
func BenchmarkEventLogEmit(b *testing.B) {
	for i := 0; i < b.N; i++ {
		if Value() != 1 {
			b.Fatal("the C function returned another value")
		}
	}
}
