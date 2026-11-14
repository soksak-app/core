//go:build darwin

package darwin

import (
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
