//go:build darwin

package darwin

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	fixture "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

const earlyShowChild = "SOKSAK_DARWIN_EARLY_SHOW_CHILD"

// Each child starts with untouched provider state. All functions come from the
// real native fixture; only window presentation is intercepted, so no AppKit
// window is needed to exercise the documented pre-host framework show path.
func TestShowWindowInitializesNativeProviderBeforeHostStartup(t *testing.T) {
	mode := os.Getenv(earlyShowChild)
	if mode == "" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, scenario := range []string{"installed", "missing", "failure"} {
			t.Run(scenario, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				command := exec.CommandContext(ctx, executable, "-test.run=^TestShowWindowInitializesNativeProviderBeforeHostStartup$", "-test.v")
				command.Env = append(os.Environ(), earlyShowChild+"="+scenario)
				if output, err := command.CombinedOutput(); err != nil {
					t.Fatalf("early-show %s: %v\n%s", scenario, err, output)
				}
			})
		}
		return
	}

	const window = platform.Window(17)
	switch mode {
	case "installed":
		var providerCalls int
		var shown []uintptr
		err := fixture.InstallProviders(func(provider func(abi.Callbacks) (abi.NativeFunctions, error)) error {
			return InstallNativeProvider(func(callbacks abi.Callbacks) (abi.NativeFunctions, error) {
				providerCalls++
				functions, err := provider(callbacks)
				if err != nil {
					return abi.NativeFunctions{}, err
				}
				functions.MainSpWindowShow = func(value uintptr) { shown = append(shown, value) }
				return functions, nil
			})
		})
		if err != nil {
			t.Fatal(err)
		}
		run := fixture.TestOnlyRunDirectly()
		fixture.InstallMainThread(run, run)
		if providerCalls != 0 {
			t.Fatal("provider was eagerly initialized before the first native operation")
		}
		if err := (implementation{}).ShowWindow(window); err != nil {
			t.Fatal(err)
		}
		if providerCalls != 1 || !reflect.DeepEqual(shown, []uintptr{uintptr(window)}) {
			t.Fatalf("early show: provider calls %d, windows %v", providerCalls, shown)
		}
		if err := (implementation{}).RequireMainThread(); err != nil {
			t.Fatal(err)
		}
		if err := (implementation{}).ShowWindow(window); err != nil {
			t.Fatal(err)
		}
		if providerCalls != 1 || !reflect.DeepEqual(shown, []uintptr{uintptr(window), uintptr(window)}) {
			t.Fatalf("later show reinitialized or lost provider: calls %d, windows %v", providerCalls, shown)
		}
	case "missing":
		for range 2 {
			err := (implementation{}).ShowWindow(window)
			if err == nil || !strings.Contains(err.Error(), "framework adapter has not installed its native provider") {
				t.Fatalf("missing provider error: %v", err)
			}
		}
	case "failure":
		failure := errors.New("early-show provider failure")
		providerCalls := 0
		if err := InstallNativeProvider(func(abi.Callbacks) (abi.NativeFunctions, error) {
			providerCalls++
			return abi.NativeFunctions{}, failure
		}); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			if err := (implementation{}).ShowWindow(window); !errors.Is(err, failure) {
				t.Fatalf("provider failure was lost: %v", err)
			}
		}
		if providerCalls != 1 {
			t.Fatalf("failed provider ran %d times", providerCalls)
		}
	default:
		t.Fatalf("unknown early-show child scenario %q", mode)
	}
}
