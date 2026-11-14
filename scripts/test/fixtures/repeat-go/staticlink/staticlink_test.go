package staticlink

import (
	"os"
	"strconv"
	"testing"
)

// TestLinked compares the value of the linked library with FIXTURE_STATIC_WANT, the value of the library that pkg-config names.
func TestLinked(t *testing.T) {
	want, err := strconv.Atoi(os.Getenv("FIXTURE_STATIC_WANT"))
	if err != nil {
		t.Fatalf("FIXTURE_STATIC_WANT is not a number: %v", err)
	}
	if got := Value(); got != want {
		t.Fatalf("the test binary linked a library with value %d, the library of pkg-config has value %d", got, want)
	}
}
