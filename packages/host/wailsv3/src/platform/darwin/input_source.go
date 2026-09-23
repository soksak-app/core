//go:build darwin && diagnostics

package darwin

// 키보드 입력 소스를 읽고 선택한다. 구현은 native/darwin 의 input_source.m 이다. 진단 빌드에만 들어간다.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "input_source.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"strings"
	"unsafe"
)

// InputSource 는 현재 선택된 키보드 입력 소스의 식별자를 반환한다. 메인 스레드에서 호출한다.
func (implementation) InputSource() (string, error) {
	pointer := C.sp_input_source_current()
	if pointer == nil {
		return "", errors.New("the selected keyboard input source could not be read")
	}
	defer C.free(unsafe.Pointer(pointer))
	return C.GoString(pointer), nil
}

// SelectInputSource 는 켜져 있는 입력 소스 가운데 identifier 를 선택한다. 메인 스레드에서 호출한다.
func (implementation) SelectInputSource(identifier string) error {
	if strings.IndexByte(identifier, 0) >= 0 {
		return errors.New("input source identifier contains NUL")
	}
	wanted := C.CString(identifier)
	defer C.free(unsafe.Pointer(wanted))
	if !bool(C.sp_input_source_select(wanted)) {
		return fmt.Errorf("input source %s is not enabled or could not be selected", identifier)
	}
	return nil
}
