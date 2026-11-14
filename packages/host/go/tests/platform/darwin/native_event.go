//go:build darwin

package darwin

import "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/testlibrary"

// EmitNativeEvent stores the event name with the class (the order of docs/spec/logging.md#classes-and-policy), the level (0 error to 4 trace) and the
// fields (JSON text) in the native event ring of this process through the producer function of the native library, as a native producer does. It is an
// error when the native library refuses the event, which it counts as lost or gated. The test library calls the producer of the production library
// that the host of the tests loaded, so the ring is the ring that the host pulls.
func EmitNativeEvent(eventClass, level uint8, name, fields string) error {
	cname := append([]byte(name), 0)
	cfields := append([]byte(fields), 0)
	return testlibrary.Error(requireNativeFunctions().SpHostTestEmitEvent(eventClass, level, &cname[0], &cfields[0]))
}
