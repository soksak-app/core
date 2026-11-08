//go:build darwin

package abi_test

import (
	"bytes"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
)

// The fixture owns every backing slice until Free, just as the native allocator
// owns allocations until their caller explicitly releases them.
type allocationFixture struct {
	functions abi.NativeFunctions
	owned     map[unsafe.Pointer][]byte
	fail      bool
	frees     int
}

func newAllocationFixture() *allocationFixture {
	fixture := &allocationFixture{owned: make(map[unsafe.Pointer][]byte)}
	fixture.functions.Malloc = func(length uint64) unsafe.Pointer {
		if fixture.fail {
			return nil
		}
		if length == 0 {
			length = 1
		}
		storage := bytes.Repeat([]byte{0xa5}, int(length))
		pointer := unsafe.Pointer(&storage[0])
		fixture.owned[pointer] = storage
		return pointer
	}
	fixture.functions.Calloc = func(count, size uint64) unsafe.Pointer {
		pointer := fixture.functions.Malloc(count * size)
		if pointer != nil {
			clear(fixture.owned[pointer])
		}
		return pointer
	}
	fixture.functions.Free = func(pointer unsafe.Pointer) {
		delete(fixture.owned, pointer)
		fixture.frees++
	}
	fixture.functions.Strlen = func(pointer *byte) uint64 {
		storage := fixture.owned[unsafe.Pointer(pointer)]
		for index, value := range storage {
			if value == 0 {
				return uint64(index)
			}
		}
		panic("fixture string is not NUL terminated")
	}
	return fixture
}

func mustPanic(t *testing.T, operation func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Error("invalid native memory operation did not panic")
		}
	}()
	operation()
}

// contract: platform.native-memory.cstring-is-a-nul-terminated-copy-the-caller-frees
func TestCStringOwnsANulTerminatedNativeCopyUntilCallerFree(t *testing.T) {
	fixture := newAllocationFixture()
	text := "한글/native"
	pointer := fixture.functions.CString(text)
	storage := fixture.owned[unsafe.Pointer(pointer)]
	if !bytes.Equal(storage, append([]byte(text), 0)) {
		t.Fatalf("native string bytes: %v", storage)
	}
	if fixture.frees != 0 || len(fixture.owned) != 1 {
		t.Fatal("CString did not leave ownership with its caller")
	}
	storage[0] = '!'
	if text != "한글/native" {
		t.Fatal("native storage aliases the Go string")
	}
	fixture.functions.Free(unsafe.Pointer(pointer))
	if len(fixture.owned) != 0 || fixture.frees != 1 {
		t.Fatal("caller could not release its native string")
	}
	empty := fixture.functions.CString("")
	if empty == nil || *empty != 0 {
		t.Fatal("empty string lacks its native NUL byte")
	}
	fixture.functions.Free(unsafe.Pointer(empty))
}

// contract: platform.native-memory.gostring-copies-to-the-first-nul
func TestGoStringCopiesNativeBytesAndAcceptsNil(t *testing.T) {
	fixture := newAllocationFixture()
	if got := fixture.functions.GoString(nil); got != "" {
		t.Fatalf("nil string: %q", got)
	}
	pointer := fixture.functions.CString("before\x00after")
	text := fixture.functions.GoString(pointer)
	if text != "before" {
		t.Fatalf("NUL boundary lost: %q", text)
	}
	fixture.owned[unsafe.Pointer(pointer)][0] = '!'
	fixture.functions.Free(unsafe.Pointer(pointer))
	if text != "before" {
		t.Fatal("Go string aliases native bytes")
	}
}

// contract: platform.native-memory.cbytes-is-a-binary-copy-the-caller-frees
func TestCBytesCopiesBinaryDataAndLeavesCallerOwnership(t *testing.T) {
	fixture := newAllocationFixture()
	input := []byte{0, 2, 0xff, 0, 7}
	pointer := fixture.functions.CBytes(input)
	storage := fixture.owned[pointer]
	if !bytes.Equal(storage[:len(input)], input) {
		t.Fatalf("binary native copy: %v", storage)
	}
	input[1] = 9
	if storage[1] != 2 {
		t.Fatal("native bytes alias the Go input")
	}
	storage[2] = 8
	if input[2] != 0xff || fixture.frees != 0 {
		t.Fatal("native copy changed input or released caller ownership")
	}
	fixture.functions.Free(pointer)
	empty := fixture.functions.CBytes(nil)
	if empty == nil || len(fixture.owned) != 1 {
		t.Fatal("empty bytes did not preserve native allocation ownership")
	}
	fixture.functions.Free(empty)
}

// contract: platform.native-memory.gobytes-copies-the-requested-range
func TestGoBytesCopiesTheRequestedNativeRange(t *testing.T) {
	fixture := newAllocationFixture()
	pointer := fixture.functions.CBytes([]byte{0, 2, 0xff, 7})
	got := fixture.functions.GoBytes(pointer, 3)
	if !bytes.Equal(got, []byte{0, 2, 0xff}) {
		t.Fatalf("native byte range: %v", got)
	}
	fixture.owned[pointer][1] = 9
	if got[1] != 2 {
		t.Fatal("Go bytes alias native storage")
	}
	got[2] = 8
	if fixture.owned[pointer][2] != 0xff || fixture.frees != 0 {
		t.Fatal("Go copy changed native storage or released caller ownership")
	}
	fixture.functions.Free(pointer)
	if len(fixture.functions.GoBytes(nil, 0)) != 0 {
		t.Fatal("zero-length native range is not empty")
	}
}

// contract: platform.native-memory.invalid-range-or-failed-allocation-panics
func TestNativeMemoryHelpersRejectInvalidRangesAndFailedAllocations(t *testing.T) {
	fixture := newAllocationFixture()
	mustPanic(t, func() { fixture.functions.GoBytes(nil, -1) })
	mustPanic(t, func() { fixture.functions.GoBytes(nil, 1) })
	fixture.fail = true
	mustPanic(t, func() { fixture.functions.CString("allocation fails") })
	mustPanic(t, func() { fixture.functions.CString("") })
	mustPanic(t, func() { fixture.functions.CBytes([]byte{1}) })
	mustPanic(t, func() { fixture.functions.CBytes(nil) })
}
