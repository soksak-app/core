package host_test

// Checks the rules of the application arguments (docs/spec/hosts.md#application-arguments).

import (
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// contract: host.arguments.declared-only
func TestApplicationArgumentsAreDeclaredOnly(t *testing.T) {
	for _, args := range [][]string{{"--config-dir", "/tmp/a"}, {"--config-dir=/tmp/a"}} {
		options, err := host.ParseArguments(args)
		if err != nil || options.ConfigDir != "/tmp/a" {
			t.Fatalf("%v: %+v %v", args, options, err)
		}
	}
	if options, err := host.ParseArguments(nil); err != nil || options.ConfigDir != "" {
		t.Fatalf("no arguments: %+v %v", options, err)
	}
	// A pair of the macOS argument domain passes, as Foundation reads it from the command line itself.
	for _, args := range [][]string{
		{"-AppleShowScrollBars", "Always", "--config-dir", "/tmp/a"},
		{"--config-dir", "/tmp/a", "-AppleShowScrollBars", "WhenScrolling", "-_Key2", "-x"},
	} {
		options, err := host.ParseArguments(args)
		if err != nil || options.ConfigDir != "/tmp/a" {
			t.Fatalf("%v: %+v %v", args, options, err)
		}
	}
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"--config-dri", "/tmp/a"}, "unknown argument --config-dri"},
		{[]string{"-config-dir", "/tmp/a"}, "unknown argument -config-dir"},
		{[]string{"/tmp/a"}, "unknown argument /tmp/a"},
		{[]string{"--config-dir"}, "--config-dir needs a value"},
		{[]string{"--config-dir="}, "--config-dir needs a value"},
		{[]string{"--config-dir", "/tmp/a", "--config-dir=/tmp/b"}, "--config-dir is given twice"},
		{[]string{"-AppleShowScrollBars"}, "-AppleShowScrollBars needs a value"},
		{[]string{"-AppleShowScrollBars", ""}, "-AppleShowScrollBars needs a value"},
		{[]string{"-AppleShowScrollBars", "Always", "-AppleShowScrollBars", "Always"}, "-AppleShowScrollBars is given twice"},
		{[]string{"-"}, "unknown argument -"},
		{[]string{"-Apple.Show", "Always"}, "unknown argument -Apple.Show"},
		{[]string{"-1Key", "Always"}, "unknown argument -1Key"},
	} {
		if _, err := host.ParseArguments(c.args); err == nil || err.Error() != c.want {
			t.Fatalf("%v: %v, want %q", c.args, err, c.want)
		}
	}
}
