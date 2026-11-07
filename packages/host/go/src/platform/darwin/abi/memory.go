//go:build darwin

package abi

import "unsafe"

// CString copies value into a NUL-terminated native allocation. The caller owns
// the returned pointer and must release it with the same NativeFunctions.Free.
func (functions NativeFunctions) CString(value string) *byte {
	length := uint64(len(value)) + 1
	pointer := functions.Malloc(length)
	if pointer == nil {
		panic("native CString allocation failed")
	}
	storage := unsafe.Slice((*byte)(pointer), length)
	copy(storage, value)
	storage[len(value)] = 0
	return (*byte)(pointer)
}

// GoString copies the bytes before the native NUL terminator into Go memory.
// A nil pointer represents an empty string; ownership stays with the caller.
func (functions NativeFunctions) GoString(pointer *byte) string {
	if pointer == nil {
		return ""
	}
	return string(unsafe.Slice(pointer, functions.Strlen(pointer)))
}

// CBytes copies value into native memory, including a native allocation for an
// empty value. The caller must release the result with NativeFunctions.Free.
func (functions NativeFunctions) CBytes(value []byte) unsafe.Pointer {
	pointer := functions.Malloc(uint64(len(value)))
	if pointer == nil {
		panic("native CBytes allocation failed")
	}
	copy(unsafe.Slice((*byte)(pointer), len(value)), value)
	return pointer
}

// GoBytes copies exactly length native bytes into Go memory without releasing
// the native allocation. A zero-length range may use a nil pointer.
func (functions NativeFunctions) GoBytes(pointer unsafe.Pointer, length int32) []byte {
	if length < 0 {
		panic("native byte length is negative")
	}
	if length == 0 {
		return []byte{}
	}
	if pointer == nil {
		panic("native byte pointer is nil for a nonempty range")
	}
	result := make([]byte, int(length))
	copy(result, unsafe.Slice((*byte)(pointer), int(length)))
	return result
}
