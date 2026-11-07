//go:build darwin

package nativeworker_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/egoist/mygo"
	binding "github.com/soksak-app/core/packages/host/mygo/src/platform/darwin/nativecallback"
)

const childFlag = "SOKSAK_NATIVE_CALLBACK_WORKER_CHILD"
const lifecycleReturned = "native callback worker lifecycle returned"

func openLibrary() (uintptr, error) {
	path := os.Getenv("SOKSAK_NATIVE_CALLBACK_WORKER_LIBRARY")
	if path == "" {
		return 0, fmt.Errorf("SOKSAK_NATIVE_CALLBACK_WORKER_LIBRARY is required; run make test-host-callback-worker")
	}
	return purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_LOCAL)
}

func TestMain(m *testing.M) {
	if os.Getenv(childFlag) != "1" {
		os.Exit(m.Run())
	}
	library, err := openLibrary()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var blockSignals func() int32
	var installThread func(uintptr, uintptr)
	purego.RegisterLibFunc(&blockSignals, library, "sp_block_async_signals")
	purego.RegisterLibFunc(&installThread, library, "hostInstallMainThread")
	if result := blockSignals(); result != 0 {
		fmt.Fprintf(os.Stderr, "main-thread signal setup: %d\n", result)
		os.Exit(2)
	}
	installThread(mygo.RunOnWorkerAddress(), mygo.RunOnMainAddress())
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyProhibited)
	mygo.App.SetSelfActivation(false)
	mygo.App.SetSignalQuit(false)
	mygo.App.SetNotificationDelegate(false)
	mygo.App.OnWindowAllClosed(func() {})
	finished := make(chan int, 1)
	mygo.App.WhenReady(func() {
		go func() {
			code := m.Run()
			if code != 0 {
				os.Exit(code)
			} // Preserve failure even if the framework later force-exits with status zero.
			finished <- code
			mygo.App.Quit()
		}()
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	select {
	case code := <-finished:
		fmt.Println(lifecycleReturned)
		os.Exit(code)
	default:
		fmt.Fprintln(os.Stderr, "framework returned before worker tests finished")
		os.Exit(2)
	}
}

func TestNativeCallbacksUseTheFrameworkWorker(t *testing.T) {
	if os.Getenv(childFlag) != "1" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, executable, "-test.run=^TestNativeCallbacksUseTheFrameworkWorker$", "-test.v")
		command.Env = append(os.Environ(), childFlag+"=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("native worker child: %v\n%s", err, output)
		}
		if !strings.Contains(string(output), lifecycleReturned) {
			t.Fatalf("framework did not return normally:\n%s", output)
		}
		t.Log(string(output))
		return
	}
	library, err := openLibrary()
	if err != nil {
		t.Fatal(err)
	}
	var install func(unsafe.Pointer) *byte
	var thread func() uint64
	var probe func(uintptr, *uint64) int32
	var touch func(unsafe.Pointer) int32
	var present func(unsafe.Pointer)
	purego.RegisterLibFunc(&install, library, "sp_host_callbacks_install")
	purego.RegisterLibFunc(&thread, library, "sp_test_worker_thread")
	purego.RegisterLibFunc(&probe, library, "sp_test_worker_probe")
	purego.RegisterLibFunc(&touch, library, "sp_test_worker_touch")
	purego.RegisterLibFunc(&present, library, "sp_test_worker_present")
	var callbacks binding.Callbacks
	fields := reflect.ValueOf(&callbacks).Elem()
	for i := range fields.NumField() {
		signature := fields.Field(i).Type()
		fields.Field(i).Set(reflect.MakeFunc(signature, func([]reflect.Value) []reflect.Value {
			values := make([]reflect.Value, signature.NumOut())
			for i := range values {
				values[i] = reflect.Zero(signature.Out(i))
			}
			return values
		}))
	}
	const token = uintptr(0xfedcba9876543201)
	var initialWorker uint64
	var state unsafe.Pointer
	var failures []string
	var hitCount, messageCount, presentationCount int
	callbacks.SurfaceHit = func(got uintptr, context unsafe.Pointer) int32 {
		hitCount++
		if got != token || thread() != initialWorker {
			failures = append(failures, "surface callback lost token or worker thread identity")
		}
		state = context
		return -51
	}
	callbacks.NativeMessage = func(got uint64, message *byte) {
		messageCount++
		if got != uint64(token) || thread() != initialWorker {
			failures = append(failures, "message callback lost token or worker identity")
		}
		if string(unsafe.Slice(message, 15)) != "borrowed-before" {
			failures = append(failures, "borrowed input changed before the callback")
		}
		if touch(state) != 53 {
			failures = append(failures, "nested main call lost its result or thread")
		}
		if string(unsafe.Slice(message, 15)) != "borrowed-after!" {
			failures = append(failures, "borrowed input did not survive the nested main call")
		}
	}
	callbacks.NativeSettledPresent = func(got uintptr, completion unsafe.Pointer) {
		presentationCount++
		if got != token || thread() != initialWorker {
			failures = append(failures, "presentation callback lost token or worker identity")
		}
		present(completion)
	}
	table, err := callbacks.Bind()
	if err != nil {
		t.Fatal(err)
	}
	if install(unsafe.Pointer(&table[0])) != nil {
		t.Fatal("native callback registration failed")
	}
	var record [6]uint64
	var result int32
	mygo.RunOnMain(func() { initialWorker = thread(); result = probe(token, &record[0]) })
	if result != 0 {
		t.Errorf("native worker probe failed: %d", result)
	}
	if initialWorker == 0 || record[0] == 0 || record[0] == initialWorker || record[1] != initialWorker {
		t.Errorf("thread identities: initial worker %d, native main/worker %v", initialWorker, record[:2])
	}
	if record[2] != record[0] || record[3] != record[0] || record[4] != 1 || record[5] != 1 {
		t.Errorf("main reentrancy, completion and borrowed scope: %v", record)
	}
	if hitCount != 1 || messageCount != 1 || presentationCount != 1 {
		t.Errorf("callback counts: %d %d %d", hitCount, messageCount, presentationCount)
	}
	t.Logf("native main=%d worker=%d nested main=%d completion main=%d", record[0], record[1], record[2], record[3])
	for _, failure := range failures {
		t.Error(failure)
	}
}
