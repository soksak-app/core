package host_test

import (
	"reflect"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: deep-link.parse.accepts-core-and-plugin-owners
func TestDeepLinkParseAcceptsCoreAndPluginOwners(t *testing.T) {
	link, err := host.ParseDeepLink("soksak://core/tab.move?tab=a&x=1")
	if err != nil {
		t.Fatalf("core link was refused: %v", err)
	}
	if link.Owner != "core" || link.Command != "tab.move" || link.Name() != "core.tab.move" {
		t.Fatalf("core link parsed as owner %q command %q name %q", link.Owner, link.Command, link.Name())
	}
	if !reflect.DeepEqual(link.Params, map[string]string{"tab": "a", "x": "1"}) {
		t.Fatalf("core link params %v", link.Params)
	}
	plugin, err := host.ParseDeepLink("soksak://sample/open")
	if err != nil {
		t.Fatalf("plugin link was refused: %v", err)
	}
	if plugin.Name() != "sample.open" || len(plugin.Params) != 0 {
		t.Fatalf("plugin link parsed as name %q params %v", plugin.Name(), plugin.Params)
	}
}

// contract: deep-link.parse.decodes-percent-encoded-params
func TestDeepLinkParseDecodesPercentEncodedParams(t *testing.T) {
	link, err := host.ParseDeepLink("soksak://core/x?q=a+b%20c&%E2%82%A9=%EA%B0%80&path=%2Ftmp%2Fa.hwp")
	if err != nil {
		t.Fatalf("encoded link was refused: %v", err)
	}
	want := map[string]string{"q": "a b c", "₩": "가", "path": "/tmp/a.hwp"}
	if !reflect.DeepEqual(link.Params, want) {
		t.Fatalf("params %v, want %v", link.Params, want)
	}
}

// contract: deep-link.parse.rejects-other-scheme
func TestDeepLinkParseRejectsOtherScheme(t *testing.T) {
	_, err := host.ParseDeepLink("https://core/x")
	if err == nil || err.Error() != `scheme "https" is not soksak` {
		t.Fatalf("error %v", err)
	}
}

// contract: deep-link.parse.rejects-missing-owner-or-command
func TestDeepLinkParseRejectsMissingOwnerOrCommand(t *testing.T) {
	cases := map[string]string{
		"soksak:///x":       "owner is missing",
		"soksak://core":     "command is missing",
		"soksak://core/":    "command is missing",
		"soksak://core/a/b": "command has more than one segment",
	}
	for value, want := range cases {
		_, err := host.ParseDeepLink(value)
		if err == nil || err.Error() != want {
			t.Fatalf("%s: error %v, want %s", value, err, want)
		}
	}
}

// contract: deep-link.parse.rejects-bad-query
func TestDeepLinkParseRejectsBadQuery(t *testing.T) {
	cases := map[string]string{
		"soksak://core/x?a=%zz":   "invalid percent-encoding",
		"soksak://core/x?a=%":     "invalid percent-encoding",
		"soksak://core/x?a=1&a=2": "parameter a is repeated",
	}
	for value, want := range cases {
		_, err := host.ParseDeepLink(value)
		if err == nil || err.Error() != want {
			t.Fatalf("%s: error %v, want %s", value, err, want)
		}
	}
}

// contract: deep-link.parse.rejects-long-url
func TestDeepLinkParseRejectsLongURL(t *testing.T) {
	_, err := host.ParseDeepLink("soksak://core/x?a=" + strings.Repeat("a", 8192))
	if err == nil || err.Error() != "URL is longer than 8192 characters" {
		t.Fatalf("error %v", err)
	}
	_, err = host.ParseDeepLink("soksak://[::1/x")
	if err == nil || err.Error() != "URL does not parse" {
		t.Fatalf("unparsable URL error %v", err)
	}
}

// contract: deep-link.parse.rejects-empty-param-name
func TestDeepLinkParseRejectsEmptyParamName(t *testing.T) {
	_, err := host.ParseDeepLink("soksak://core/x?=x")
	if err == nil || err.Error() != "parameter name is empty" {
		t.Fatalf("error %v", err)
	}
}

// contract: deep-link.launch.kept-links-run-in-order-when-window-ready
func TestDeepLinkQueueRunsKeptLinksInOrderWhenWindowIsReady(t *testing.T) {
	var ran []string
	var queue host.DeepLinkQueue
	run := func(value string) { ran = append(ran, value) }
	queue.Keep("soksak://core/a", run)
	queue.Keep("soksak://core/b", run)
	if len(ran) != 0 {
		t.Fatalf("kept links ran before the window was ready: %v", ran)
	}
	queue.Ready(run)
	if want := []string{"soksak://core/a", "soksak://core/b"}; !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v, want %v", ran, want)
	}
}

// contract: deep-link.launch.later-link-runs-at-once
func TestDeepLinkQueueRunsLaterLinkAtOnce(t *testing.T) {
	var ran []string
	var queue host.DeepLinkQueue
	run := func(value string) { ran = append(ran, value) }
	queue.Ready(run)
	queue.Keep("soksak://core/c", run)
	queue.Ready(run)
	if want := []string{"soksak://core/c"}; !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v, want %v", ran, want)
	}
}
