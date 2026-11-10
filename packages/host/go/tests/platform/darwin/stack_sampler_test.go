//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	testabi "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/abi"
)

// Every unused native operation fails explicitly; these are not substitute
// success implementations for sampling, recorder, or framework work.
func failingUnusedNativeFunctions() testabi.NativeFunctions {
	var functions testabi.NativeFunctions
	fields := reflect.ValueOf(&functions).Elem()
	for index := range fields.NumField() {
		name := fields.Type().Field(index).Name
		fields.Field(index).Set(reflect.MakeFunc(fields.Field(index).Type(), func([]reflect.Value) []reflect.Value {
			panic(fmt.Sprintf("unexpected native test operation %s", name))
		}))
	}
	return functions
}

// contract: verification.native-test-facade.validates-provider-and-recordings
func TestNativeTestFacadeRequiresOneCompleteProviderAndRejectsIncompleteRecordings(t *testing.T) {
	const childFlag = "SOKSAK_NATIVE_TEST_FACADE_CHILD"
	if os.Getenv(childFlag) != "1" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		command := exec.Command(executable, childArguments(t, "-test.run=^TestNativeTestFacadeRequiresOneCompleteProviderAndRejectsIncompleteRecordings$", "-test.v")...)
		command.Env = append(os.Environ(), childFlag+"=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("native facade child: %v\n%s", err, output)
		}
		return
	}
	if err := CaptureMainThread(); err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("capture before installation: %v", err)
	}
	if err := InstallNativeFunctions(testabi.NativeFunctions{}); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("incomplete native function table: %v", err)
	}
	functions := failingUnusedNativeFunctions()
	capture, start, stop := int32(1), int32(0), int32(0)
	functions.SpHostTestSamplerCaptureMain = func() int32 { return capture }
	functions.SpHostTestSamplerStart = func() int32 { return start }
	functions.SpHostTestSamplerStop = func() int32 { return stop }
	functions.SpHostTestSamplerPhaseSamples = func(phase int32) uint64 { return uint64(phase + 10) }
	functions.SpHostTestSamplerPhaseOutside = func(int32) uint64 { return 2 }
	functions.SpHostTestSamplerPhaseFirstOutside = func(int32) uintptr { return 31 }
	failures := uint64(0)
	functions.SpHostTestSamplerFailureCount = func() uint64 { return failures }
	functions.SpHostTestSamplerFailureLast = func() int32 { return 37 }
	functions.SpHostTestRecorderStop = func() uint64 { return 2 }
	dropped := uint64(0)
	functions.SpHostTestRecorderDropped = func() uint64 { return dropped }
	missing := true
	functions.SpHostTestRecorderEntryAt = func(index uint64, at *uint64, activity, defaultMode, hasTimer *int32, timerIn *int64, sentInWait, answered *uint64) int32 {
		if index == 1 && missing {
			return 0
		}
		*at, *activity, *defaultMode, *hasTimer = index+1, int32(testabi.SP_HOST_TEST_RUN_LOOP_ENTRY), 1, 1
		*timerIn, *sentInWait, *answered = 5, 6, 7
		return 1
	}
	if err := InstallNativeFunctions(functions); err != nil {
		t.Fatal(err)
	}
	if err := InstallNativeFunctions(functions); err == nil {
		t.Fatal("native test provider replacement was accepted")
	}
	if err := CaptureMainThread(); err != nil {
		t.Fatal(err)
	}
	capture = 0
	if err := CaptureMainThread(); err == nil || !strings.Contains(err.Error(), "not the main thread") {
		t.Fatalf("capture thread failure: %v", err)
	}
	start = 11
	if err := StartSampler(); err == nil || !strings.Contains(err.Error(), "11") {
		t.Fatalf("sampler start error: %v", err)
	}
	start = 0
	if err := StartSampler(); err != nil {
		t.Fatal(err)
	}
	stop = 12
	if _, err := StopSampler(); err == nil || !strings.Contains(err.Error(), "12") {
		t.Fatalf("sampler stop error: %v", err)
	}
	stop, failures = 0, 2
	counts, err := StopSampler()
	if err == nil || !strings.Contains(err.Error(), "2 thread calls failed") || !strings.Contains(err.Error(), "37") {
		t.Fatalf("sampler kernel errors: %v", err)
	}
	if len(counts) != Phases || counts[0] != (PhaseCount{Samples: 10, Outside: 2, FirstOutside: 31}) {
		t.Fatalf("sampler counts lost on failure: %v", counts)
	}
	activities, err := StopRunLoopRecorder()
	if err == nil || !strings.Contains(err.Error(), "1") {
		t.Fatalf("unreadable recorder entry was silently discarded: %v, %v", activities, err)
	}
	missing, dropped = false, 3
	if _, err := StopRunLoopRecorder(); err == nil || !strings.Contains(err.Error(), "3 activities") {
		t.Fatalf("recorder overflow: %v", err)
	}
	dropped = 0
	activities, err = StopRunLoopRecorder()
	if err != nil || len(activities) != 2 || activities[0].Activity != "entry" || !activities[0].HasTimer || activities[0].TimerIn != 5 || activities[0].SentInWait != 6 || activities[0].Answered != 7 {
		t.Fatalf("complete recorder result: %+v, %v", activities, err)
	}
}

// childArguments are the arguments of a child run of this test binary. The child takes the rest of the limit of the runner as its
// own, so a child that does not end panics at that limit with its stacks and does not outlive its parent.
func childArguments(t *testing.T, arguments ...string) []string {
	if deadline, ok := t.Deadline(); ok {
		arguments = append(arguments, "-test.timeout="+time.Until(deadline).String())
	}
	return arguments
}
