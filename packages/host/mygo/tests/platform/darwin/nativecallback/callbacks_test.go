//go:build darwin && diagnostics

package nativecallback_test

import (
	"fmt"
	"os"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"github.com/ebitengine/purego"
	binding "github.com/soksak-app/core/packages/host/mygo/src/platform/darwin/nativecallback"
)

func complete(value any, handler func(string, []reflect.Value) []reflect.Value) {
	fields := reflect.ValueOf(value).Elem()
	for i := range fields.NumField() {
		name := fields.Type().Field(i).Name
		fields.Field(i).Set(reflect.MakeFunc(fields.Field(i).Type(), func(args []reflect.Value) []reflect.Value { return handler(name, args) }))
	}
}

func TestMissingCallbacksAllocateNoAddresses(t *testing.T) {
	var callbacks binding.Callbacks
	complete(&callbacks, func(string, []reflect.Value) []reflect.Value { return nil })
	for i := range reflect.TypeOf(callbacks).NumField() {
		missing := callbacks
		reflect.ValueOf(&missing).Elem().Field(i).SetZero()
		if _, err := missing.Bind(); err == nil || !strings.Contains(err.Error(), "missing") {
			t.Fatalf("field %d: %v", i, err)
		}
	}
	callbacks.MouseButtonsChanged = nil
	// The purego pool holds 2000 addresses. Any allocation on the invalid path exhausts it.
	for range 2001 {
		if _, err := callbacks.Bind(); err == nil {
			t.Fatal("missing last callback accepted")
		}
	}
	var diagnostics binding.DiagnosticCallbacks
	complete(&diagnostics, func(string, []reflect.Value) []reflect.Value { return nil })
	for i := range reflect.TypeOf(diagnostics).NumField() {
		missing := diagnostics
		reflect.ValueOf(&missing).Elem().Field(i).SetZero()
		if _, err := missing.Bind(); err == nil {
			t.Fatalf("diagnostic field %d accepted", i)
		}
	}
	diagnostics.ProcessExitAnswered = nil
	for range 2001 {
		if _, err := diagnostics.Bind(); err == nil {
			t.Fatal("missing last diagnostic callback accepted")
		}
	}
}

func TestNativeCallbacksPreserveTheDeclaredABI(t *testing.T) {
	library := os.Getenv("SOKSAK_NATIVE_CALLBACK_ABI_LIBRARY")
	if library == "" {
		t.Fatal("SOKSAK_NATIVE_CALLBACK_ABI_LIBRARY must name the built native ABI fixture; run make test-host-callbacks")
	}
	handle, err := purego.Dlopen(library, purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		t.Fatal(err)
	}
	// Retain the native code and callback addresses until process exit.
	var install, installDiagnostic func(unsafe.Pointer) *byte
	var layout func(*uint64, bool) uint64
	var context, held func() unsafe.Pointer
	var text func() *byte
	var allocateBytes func() unsafe.Pointer
	var allocateKind func() *byte
	var release func(unsafe.Pointer)
	var run func() int32
	purego.RegisterLibFunc(&install, handle, "sp_host_callbacks_install")
	purego.RegisterLibFunc(&installDiagnostic, handle, "sp_host_diagnostic_callbacks_install")
	purego.RegisterLibFunc(&layout, handle, "sp_test_callback_layout")
	purego.RegisterLibFunc(&context, handle, "sp_test_callback_context")
	purego.RegisterLibFunc(&held, handle, "sp_test_callback_held")
	purego.RegisterLibFunc(&text, handle, "sp_test_callback_text")
	purego.RegisterLibFunc(&allocateBytes, handle, "sp_test_callback_bytes")
	purego.RegisterLibFunc(&allocateKind, handle, "sp_test_callback_kind")
	purego.RegisterLibFunc(&release, handle, "sp_test_callback_free")
	purego.RegisterLibFunc(&run, handle, "sp_test_callback_run")
	expectedContext, expectedHeld, expectedText := context(), held(), text()
	seen := map[string]int{}
	var order []string
	var failures []string
	handler := func(name string, args []reflect.Value) []reflect.Value {
		seen[name]++
		order = append(order, name)
		for i, arg := range args {
			if name == "CoreRootServe" && i >= 3 {
				continue
			}
			var want any
			switch arg.Kind() {
			case reflect.Uintptr:
				want = uintptr(0xfedcba9876543201)
			case reflect.Uint64:
				want = uint64(0xfedcba9876543210)
			case reflect.Int32:
				want = int32(-37)
			case reflect.Int64:
				want = int64(-83)
			case reflect.Float64:
				want = float64(-12.5)
			case reflect.Bool:
				want = true
			case reflect.UnsafePointer:
				want = expectedContext
				if name == "InputDelivered" && i == 2 {
					want = expectedHeld
				}
			case reflect.Pointer:
				want = expectedText
			default:
				failures = append(failures, fmt.Sprintf("unsupported test argument %s[%d]: %s", name, i, arg.Type()))
				continue
			}
			if name == "NativeSettledDone" && i == 2 {
				release(unsafe.Pointer(arg.Interface().(*byte)))
			} else if !reflect.DeepEqual(arg.Interface(), want) {
				failures = append(failures, fmt.Sprintf("%s[%d]: got %v, want %v", name, i, arg.Interface(), want))
			}
		}
		if name == "SurfaceHit" {
			return []reflect.Value{reflect.ValueOf(int32(-51))}
		}
		if name == "CoreRootServe" {
			*args[3].Interface().(*unsafe.Pointer) = allocateBytes()
			*args[4].Interface().(*uint64) = 4
			*args[5].Interface().(**byte) = allocateKind()
			return []reflect.Value{reflect.ValueOf(true)}
		}
		return nil
	}
	var callbacks binding.Callbacks
	complete(&callbacks, handler)
	table, err := callbacks.Bind()
	if err != nil {
		t.Fatal(err)
	}
	var diagnostics binding.DiagnosticCallbacks
	complete(&diagnostics, handler)
	diagnosticTable, err := diagnostics.Bind()
	if err != nil {
		t.Fatal(err)
	}
	for _, profile := range []struct {
		diagnostic bool
		count      int
		size       uintptr
	}{{false, len(table), unsafe.Sizeof(table)}, {true, len(diagnosticTable), unsafe.Sizeof(diagnosticTable)}} {
		offsets := make([]uint64, profile.count)
		if got := layout(&offsets[0], profile.diagnostic); got != uint64(profile.size) {
			t.Fatalf("table size: got %d, want %d", got, profile.size)
		}
		for i, offset := range offsets {
			if offset != uint64(i)*uint64(unsafe.Sizeof(uintptr(0))) {
				t.Fatalf("field %d has offset %d", i, offset)
			}
		}
	}
	if install(unsafe.Pointer(&table[0])) != nil || installDiagnostic(unsafe.Pointer(&diagnosticTable[0])) != nil {
		t.Fatal("native registration rejected the complete tables")
	}
	runtime.GC()
	if result := run(); result != 0 {
		t.Errorf("native callback results failed: %d", result)
	}

	wantOrder := []string{
		"NativeCommitted", "NativeTerminated", "NativeMessage", "FileDropped", "FileDropReleased", "ImageReleased", "ImageChanged",
		"NativeStartPageReady", "NativeLayoutReady", "NativePresentationDone", "NativeSettledPresent", "NativeSettledPresentEnded",
		"NativeLayoutStarted", "NativeLayoutEnded", "NativeSettledDone", "NotificationEvent", "QuitRequest", "NativeUiRun",
		"NativeResponderChanged", "NativeFullscreenDone", "SurfaceHit", "SurfacePoint", "InputDelivered", "InputActivated",
		"DocumentChanged", "DocumentMessage", "ViewMessage", "ViewEnded", "ViewResponsiveness", "DocumentStream", "CoreRootServe",
		"DocumentQueried", "DocumentEvent", "MemoryPressure", "DockNewWindow", "MouseButtonsChanged", "NativeInputSourceAdopted",
		"WindowObjectsCounted", "PageObjectsCounted", "DeliveredNotifications", "DocumentFrameIdentityDone", "InputReferenceReply", "ProcessExitAnswered",
	}
	if !reflect.DeepEqual(order, wantOrder) {
		t.Errorf("native callback order: got %v, want %v", order, wantOrder)
	}
	for name, count := range seen {
		if count != 1 {
			t.Errorf("%s called %d times", name, count)
		}
	}
	if len(seen) != len(table)+len(diagnosticTable) {
		t.Errorf("called %d callbacks, want %d", len(seen), len(table)+len(diagnosticTable))
	}
	for _, failure := range failures {
		t.Error(failure)
	}
	if install(unsafe.Pointer(&table[0])) == nil {
		t.Fatal("native table replacement accepted")
	}
	runtime.KeepAlive(table)
	runtime.KeepAlive(diagnosticTable)
}
