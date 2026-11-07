//go:build darwin

package darwin

import (
	"fmt"
	"unsafe"
)

func (implementation) PullNativeEvents(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, fmt.Errorf("pull native events: the buffer is empty")
	}
	return int(native.SpEventDrain((*uint8)(unsafe.Pointer(&buffer[0])), uint64(len(buffer)))), nil
}

func (implementation) NativeEventWake() (int, error) {
	descriptor := int(native.SpEventWakeFd())
	if descriptor < 0 {
		return 0, fmt.Errorf("native event wake: the pipe cannot be made")
	}
	return descriptor, nil
}

func (implementation) TakeNativeEventLoss(channel uint8) (uint64, uint64, error) {
	loss := native.SpEventTakeLoss(uint8(channel))
	return uint64(loss.Events), uint64(loss.Bytes), nil
}

func (implementation) SetNativeEventPolicy(levels [5]int8) error {
	if !bool(native.SpEventSetPolicy((*int8)(unsafe.Pointer(&levels[0])))) {
		return fmt.Errorf("set native event policy: the native library refused %v (a level is -1 to 4)", levels)
	}
	return nil
}

func (implementation) MonotonicNanos() (uint64, error) {
	return uint64(native.SpMonoNs()), nil
}

func (implementation) SetEventBoot(boot string) error {
	cboot := native.CString(boot)
	defer native.Free(unsafe.Pointer(cboot))
	if !bool(native.SpEventSetBoot(cboot)) {
		return fmt.Errorf("set event boot: the native library refused %q (letters, digits, '-' and '_', at most 64 bytes)", boot)
	}
	return nil
}

func (implementation) FlushNativeObservers() error {
	native.SpObserveFlush()
	return nil
}

func (implementation) ObserveActivity() error {
	native.MainSpObserveActivity()
	return nil
}
