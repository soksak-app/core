// The cause of a quit is stored before the quit runs, and the record of an exit request names where the quit came from.
package host_test

import (
	"reflect"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// contract: log.closed.cause-before-quit
func TestAQuitStoresItsCauseBeforeItRuns(t *testing.T) {
	log := support.UseEventLog(t)
	var fields any
	host.QuitWithCause("quit-command", host.HostQuitSource("quit-command"), func() {
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		for _, event := range readEventLog(t, log.Path()) {
			if event["event"] == "log.closed" {
				fields = event["fields"]
			}
		}
	})
	if cause, _ := fields.(map[string]any); cause == nil || cause["cause"] != "quit-command" {
		t.Fatalf("log.closed before quit = %v, want the cause quit-command", fields)
	}
}

// contract: log.closed.exit-request-source
// The record of an exit request names where the quit came from: an Apple event with its sender, a signal with its sender, a quit
// of the host itself with its request, or the menu or a key with the type of the current event.
func TestTheExitRequestNamesTheSourceOfItsQuit(t *testing.T) {
	log := support.UseEventLog(t)
	// A quit that names its source reads no current event: a test fails when it asks for one.
	noMenu := func() int {
		t.Error("the exit request read the current event although its quit named a source")
		return -1
	}
	host.QuitWithCause("quit-request", host.AppleEventQuitSource(77, "com.apple.dt.Xcode"), func() { host.EmitExitRequest(noMenu) })
	host.QuitWithCause("update", host.HostQuitSource("update"), func() { host.EmitExitRequest(noMenu) })
	var state host.Quit
	host.QuitFromSignal(&state, 15, 88, func() { host.EmitExitRequest(noMenu) })
	host.QuitWithCause("quit-request", host.AppleEventQuitSource(0, ""), func() { host.EmitExitRequest(noMenu) })
	// A quit that no part of the host asked for is the menu or a key equivalent of the framework, named by the current event.
	host.EmitExitRequest(func() int { return 10 })
	host.EmitExitRequest(func() int { return -1 })
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if fields, _ := event["fields"].(map[string]any); event["event"] == "log.closed" && fields["cause"] == "exit-request" {
			got = append(got, fields)
		}
	}
	want := []map[string]any{
		{"cause": "exit-request", "source": "apple-event", "sender_pid": float64(77), "sender": "com.apple.dt.Xcode"},
		{"cause": "exit-request", "source": "host", "request": "update"},
		{"cause": "exit-request", "source": "signal", "signal": float64(15), "sender_pid": float64(88)},
		{"cause": "exit-request", "source": "apple-event"},
		{"cause": "exit-request", "source": "menu", "event_type": float64(10)},
		{"cause": "exit-request", "source": "menu"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("exit requests = %v, want %v", got, want)
	}
	if !state.Active() {
		t.Fatal("a quit of a signal did not begin the quit state")
	}
}
