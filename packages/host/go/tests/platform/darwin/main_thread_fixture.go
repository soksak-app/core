//go:build darwin

package darwin

/*
#include <stdint.h>

// test_only_run_directly runs the block on the calling thread. It stands for a main-thread function of a framework in the tests
// that run the darwin layer of the library without a framework adapter, and in no build of the host.
static void test_only_run_directly(void (^block)(void)) { block(); }
static uintptr_t test_only_run_directly_function(void) { return (uintptr_t)test_only_run_directly; }
*/
import "C"

// TestOnlyRunDirectly is a main-thread function for tests only: it runs the block on the calling thread instead of the worker or
// the main thread of a framework (docs/spec/hosts.md, main thread of the Wails host). A test package that runs the darwin layer
// without a framework adapter installs it through darwin.InstallMainThread in its TestMain.
func TestOnlyRunDirectly() uintptr { return uintptr(C.test_only_run_directly_function()) }
