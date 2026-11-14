//go:build darwin

package darwin

import (
	"math"
	"syscall"
	"testing"
)

// The system refuses a signal to a process group with an error other than ESRCH or EPERM, or the read of the processes of the
// group fails, only for an input that the host does not make; the test hands the judgement of the signal answer those errors, and
// both hosts name the system error with its number (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.names-the-system-error-by-its-number
func TestARefusedGroupSignalNamesTheSystemErrorByItsNumber(t *testing.T) {
	for _, test := range []struct {
		name    string
		answer  error
		running func() ([]int, error)
		want    string
	}{
		{"signal", syscall.EINVAL, func() ([]int, error) { panic("an EINVAL answer reads no process") }, "errno 22"},
		{"read", syscall.EPERM, func() ([]int, error) { return nil, syscall.ENOMEM }, "read the processes of the group: errno 12"},
		{"running", syscall.EPERM, func() ([]int, error) { return []int{7, 8}, nil }, "operation not permitted; running: pid 7, pid 8"},
	} {
		if err := groupSignalResult(test.answer, test.running); err == nil || err.Error() != test.want {
			t.Errorf("%s: %v, want %s", test.name, err, test.want)
		}
	}
}

// A process group id is a positive signed 32-bit number: the system reads the negated id of a group signal as 32 bits, so 0
// would signal the group of the host, a negative id one process, and an id that wraps to 0 or -1 the group of the host or every
// process. The test hands the conversion those ids without sending a signal (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.refuses-a-group-id-out-of-range
func TestAProcessGroupIDOutOfRangeIsRefused(t *testing.T) {
	for _, pid := range []int{0, -5, 1 << 31, 1 << 32, math.MaxUint32} {
		if group, err := processGroupID(pid); err == nil || err.Error() != "out of range" {
			t.Errorf("%d: %d, %v, want out of range", pid, group, err)
		}
	}
	for _, pid := range []int{1, math.MaxInt32} {
		if group, err := processGroupID(pid); err != nil || group != pid {
			t.Errorf("%d: %d, %v, want %d", pid, group, err, pid)
		}
	}
}
