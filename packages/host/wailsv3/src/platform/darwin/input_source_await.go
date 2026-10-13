//go:build darwin && diagnostics

package darwin

// The bridge from the block of sp_input_source_await to nativeInputSourceAdopted. A file that exports a Go function cannot
// define C functions in its preamble, so the bridge is here.

/*
#cgo CFLAGS: -x objective-c -fmodules -fblocks
#cgo pkg-config: soksak-darwin
#include <stdint.h>
#include "input_source.h"

extern void nativeInputSourceAdopted(uintptr_t callback, char *failure);

static void inputSourceAwait(const char *identifier, uintptr_t callback) {
    sp_input_source_await(identifier, ^(const char *error) { nativeInputSourceAdopted(callback, (char *)error); });
}
*/
import "C"

import "runtime/cgo"

func awaitInputSource(identifier *C.char, adopted cgo.Handle) {
	C.inputSourceAwait(identifier, C.uintptr_t(adopted))
}
