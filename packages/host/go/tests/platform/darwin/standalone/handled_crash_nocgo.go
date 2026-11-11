//go:build darwin && !cgo

package standalone

import (
	"os"
	"runtime"

	testlibrary "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/testlibrary"
)

// SpawnHandledCrashChild starts executable with the newline-separated arguments and adds the environment entry NAME=VALUE to
// the inherited environment. Its standard output and standard error go to output. Its crash exceptions are answered by a test
// service, so the system writes no crash report for them. It returns the child's pid and the handle for WaitHandledCrashChild.
func SpawnHandledCrashChild(executable, arguments, environment string, output *os.File) (int, uintptr, error) {
	if err := InstallTestSupport(); err != nil {
		return 0, 0, err
	}
	path := nulTerminated(executable)
	argv := nulTerminated(arguments)
	env := nulTerminated(environment)
	var pid int32
	var handle uintptr
	failure := supportFunctions.SpHostTestSpawnHandledCrash(&path[0], &argv[0], &env[0], int32(output.Fd()), &pid, &handle)
	runtime.KeepAlive(path)
	runtime.KeepAlive(argv)
	runtime.KeepAlive(env)
	if err := testlibrary.Error(failure); err != nil {
		return 0, 0, err
	}
	return int(pid), handle, nil
}

// WaitHandledCrashChild waits for the child of SpawnHandledCrashChild and returns its raw wait status and the number of
// crash exceptions that the test service answered.
func WaitHandledCrashChild(handle uintptr) (int32, int, error) {
	if err := InstallTestSupport(); err != nil {
		return 0, 0, err
	}
	var status, handled int32
	failure := supportFunctions.SpHostTestWaitHandledCrash(handle, &status, &handled)
	if err := testlibrary.Error(failure); err != nil {
		return 0, 0, err
	}
	return status, int(handled), nil
}

func nulTerminated(value string) []byte {
	return append([]byte(value), 0)
}
