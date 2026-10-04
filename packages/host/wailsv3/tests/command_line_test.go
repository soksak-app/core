package host_test

// 애플리케이션 인자의 규칙(docs/spec/hosts.md#application-arguments)을 검사한다.

import (
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
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
	} {
		if _, err := host.ParseArguments(c.args); err == nil || err.Error() != c.want {
			t.Fatalf("%v: %v, want %q", c.args, err, c.want)
		}
	}
}
