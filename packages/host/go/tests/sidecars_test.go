package host_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// fixtureSidecarsWithManifest declares the sidecar of manifest in directory. Its executable is the sidecar fixture, linked as fixture
// in directory, which runs the control text control.
func fixtureSidecarsWithManifest(t *testing.T, directory, control, manifest string) *host.Sidecars {
	t.Helper()
	support.Fixture(t, directory, "fixture", control)
	sidecars, err := host.NewSidecars(support.Declare(directory, manifest), directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	return sidecars
}

// fixtureSidecars declares the sidecar support.EchoSidecar in directory, with the sidecar fixture running the control text control.
func fixtureSidecars(t *testing.T, directory, control string) *host.Sidecars {
	t.Helper()
	return fixtureSidecarsWithManifest(t, directory, control, `{"executable":"fixture","displayName":"soksak://sidecar/probe","protocol":1}`)
}

// contract: sidecars.display-name.is-not-injected-into-child-environment
func TestSidecarProcessDoesNotReceiveItsDisplayNameFromTheHost(t *testing.T) {
	t.Setenv("SOKSAK_SIDECAR_DISPLAY_NAME", "inherited-value")
	directory := t.TempDir()
	control := "record-env SOKSAK_SIDECAR_DISPLAY_NAME " + filepath.Join(directory, "display-name") + "\n" +
		`on 1 reply {"surface":"s1","body":"ok"}` + "\non any echo\n"
	sidecars := fixtureSidecarsWithManifest(t, directory, control, `{"executable":"fixture","protocol":1,"displayName":"soksak://sidecar/probe"}`)
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	if event := owner.Next(t); event.Surface != "s1" || string(event.Body) != `"ok"` {
		t.Fatalf("sidecar event = %#v", event)
	}
	name, err := os.ReadFile(filepath.Join(directory, "display-name"))
	if err != nil {
		t.Fatal(err)
	}
	if string(name) != "inherited-value" {
		t.Fatalf("child display-name environment = %q, want inherited value unchanged", name)
	}
}

// contract: sidecars.protocol.message-at-limit-is-delivered
func TestSidecarMessageAtTheLimitIsDelivered(t *testing.T) {
	// The body is the string of x characters that fills the line limit beside the surface and the quotes of the message.
	padding := support.MessageLimit - len(`{"surface":"s1","body":"`) - len(`"}`)
	sidecars := fixtureSidecars(t, t.TempDir(), fmt.Sprintf("on 1 pad s1 %d\non any echo\n", padding))
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	event := owner.Next(t)
	body := string(event.Body)
	if event.Surface != "s1" || len(body) != padding+2 || strings.Trim(body[1:len(body)-1], "x") != "" || body[0] != '"' || body[len(body)-1] != '"' {
		t.Fatalf("message at the limit: surface %q, body length %d, want %d", event.Surface, len(body), padding+2)
	}
	select {
	case value := <-owner.Failures:
		t.Fatalf("message at the limit produced a failure: %+v", value)
	default:
	}
}

// contract: sidecars.failure.output-close-notifies-each-surface
func TestSidecarOutputCloseNotifiesEachSurface(t *testing.T) {
	// Each process answers its first line after it recorded its pid, so the answer is the event that the pid is recorded.
	directory := t.TempDir()
	sidecars := fixtureSidecars(t, directory, "append-pid "+filepath.Join(directory, "pids")+"\n"+
		`on 1 reply {"surface":"s1","body":"recorded"}`+"\non 2 exit 3\n")
	first, second := support.NewFakeOwner("/projects/a"), support.NewFakeOwner("/projects/b")
	if err := sidecars.Send(first, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	first.Next(t)
	if err := sidecars.Send(second, support.EchoSidecar, "s2", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	for surface, owner := range map[string]*support.FakeOwner{"s1": first, "s2": second} {
		failure := owner.Failure(t)
		if failure.Sidecar != support.EchoSidecar || failure.Surface != surface || failure.Reason != "output closed: exit status 3" {
			t.Fatalf("%s: failure = %+v", surface, failure)
		}
	}
	// A send after the failure starts a new process.
	if err := sidecars.Send(first, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatalf("send after failure: %v", err)
	}
	// The new process recorded its pid when it answers, before the stop ends it.
	first.Next(t)
	sidecars.Stop()
	select {
	case value := <-first.Failures:
		t.Fatalf("output end while stopping produced a failure: %+v", value)
	default:
	}
	data, err := os.ReadFile(filepath.Join(directory, "pids"))
	if err != nil {
		t.Fatal(err)
	}
	if pids := strings.Fields(string(data)); len(pids) != 2 || pids[0] == pids[1] {
		t.Fatalf("sidecar processes = %q, want two distinct processes", pids)
	}
}

// echoSidecars declares a sidecar that outputs the lines it received as they are.
// The surface and body of the request come back as an event as they are, and every request remains in the request record file.
func echoSidecars(t *testing.T) (*host.Sidecars, string) {
	t.Helper()
	directory := t.TempDir()
	record := filepath.Join(directory, "requests")
	support.Fixture(t, directory, "echo", "ignore-term\non any tee "+record+"\n")
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	return sidecars, record
}

// contract: sidecars.send.delivers-only-to-owning-window, sidecars.send.rejects-surface-owned-by-another-window, sidecars.protocol.request-lines-carry-surface-root-body, sidecars.close-owner.sends-closed-per-surface
func TestSidecarMessagesReachTheOwningWindowOnly(t *testing.T) {
	sidecars, record := echoSidecars(t)
	first, second := support.NewFakeOwner("/projects/a"), support.NewFakeOwner("/projects/b")
	if err := sidecars.Send(first, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(second, support.EchoSidecar, "s2", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if event := first.Next(t); event.Sidecar != support.EchoSidecar || event.Surface != "s1" || string(event.Body) != `{"operation":"open"}` {
		t.Fatalf("first window event = %+v", event)
	}
	if event := second.Next(t); event.Surface != "s2" {
		t.Fatalf("second window event = %+v", event)
	}
	if err := sidecars.Send(second, support.EchoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "another window") {
		t.Fatalf("send to another window's surface = %v", err)
	}
	sidecars.CloseOwner(first)
	sidecars.Stop()
	requests, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}
{"surface":"s2","root":"/projects/b","body":{"operation":"open"}}
{"surface":"s1","root":"/projects/a","closed":true}
`
	if string(requests) != want {
		t.Fatalf("requests =\n%s\nwant\n%s", requests, want)
	}
}

// contract: sidecars.protocol.surface-keeps-its-first-root
func TestSurfaceKeepsTheRootItWasOpenedWith(t *testing.T) {
	sidecars, record := echoSidecars(t)
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	// The echo is the event that the sidecar ignores the terminate signal of the stop, so it records every line.
	owner.Next(t)
	// Even after the same window changed to another project, a surface that is already open sends with the first root.
	owner.Root = "/projects/b"
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"input"}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.CloseOwner(owner)
	sidecars.Stop()
	requests, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}
{"surface":"s1","root":"/projects/a","body":{"operation":"input"}}
{"surface":"s1","root":"/projects/a","closed":true}
`
	if string(requests) != want {
		t.Fatalf("requests =\n%s\nwant\n%s", requests, want)
	}
}

// contract: sidecars.send.rejects-undeclared-sidecar, sidecars.send.rejects-after-stop
func TestUndeclaredAndStoppedSidecarsAreRejected(t *testing.T) {
	sidecars, _ := echoSidecars(t)
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, "other", "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "not declared") {
		t.Fatalf("undeclared sidecar = %v", err)
	}
	sidecars.Stop()
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "stopped") {
		t.Fatalf("send after stop = %v", err)
	}
}

// contract: sidecars.start.fails-on-missing-executable
func TestMissingSidecarExecutableFails(t *testing.T) {
	directory := t.TempDir()
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"absent","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(support.NewFakeOwner("/"), support.EchoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "sidecar "+support.EchoSidecar) {
		t.Fatalf("missing executable = %v", err)
	}
}

// contract: sidecars.start.passes-log-directory
func TestSidecarReceivesTheLogDirectory(t *testing.T) {
	directory := t.TempDir()
	sidecars := fixtureSidecars(t, directory, "record-argv "+filepath.Join(directory, "argv")+"\n"+
		`on 1 reply {"surface":"s1","body":"ok"}`+"\non any echo\n")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	owner.Next(t)
	config, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(directory, "argv"))
	if err != nil {
		t.Fatal(err)
	}
	want := "--log-dir\n" + filepath.Join(config, "logs") + "\n"
	if string(data) != want {
		t.Fatalf("arguments of the sidecar = %q, want %q", data, want)
	}
}

// contract: sidecars.declaration.adds-sidecars-installed-after-start
func TestDeclaringAddsSidecarsInstalledAfterTheStart(t *testing.T) {
	directory := t.TempDir()
	record := filepath.Join(directory, "requests")
	support.Fixture(t, directory, "echo", "ignore-term\non any tee "+record+"\n")
	sidecars, err := host.NewSidecars(nil, directory)
	if err != nil {
		t.Fatal(err)
	}
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "is not declared by any plugin") {
		t.Fatalf("send before the declaration = %v", err)
	}
	if err := sidecars.Declare(support.Declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if event := owner.Next(t); event.Surface != "s1" || string(event.Body) != `{"operation":"open"}` {
		t.Fatalf("event = %+v", event)
	}
	sidecars.Stop()
}

// contract: sidecars.declaration.rejects-executable-escaping-package, sidecars.declaration.rejects-absolute-executable, sidecars.declaration.rejects-unsupported-protocol, sidecars.declaration.rejects-unknown-transport, sidecars.declaration.rejects-host-read-operations, sidecars.display-name.requires-canonical-component
func TestInvalidSidecarDeclarationsAreNotDeclared(t *testing.T) {
	const canonical = "displayName must be soksak://sidecar/ followed by one lowercase identifier"
	cases := map[string]struct {
		sidecar string
		reason  string
	}{
		"escaping executable":     {`{"executable":"../escape","displayName":"soksak://sidecar/probe","protocol":1}`, "executable ../escape is not a path inside the package"},
		"absolute executable":     {`{"executable":"/bin/sh","displayName":"soksak://sidecar/probe","protocol":1}`, "executable /bin/sh is not a path inside the package"},
		"unknown protocol":        {`{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":2}`, "protocol 2 is not supported"},
		"unknown transport":       {`{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"transport":"ptyd"}`, "transport ptyd is not supported"},
		"host read operations":    {`{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"hostReadOperations":["list"]}`, "hostReadOperations is removed"},
		"missing display name":    {`{"executable":"echo","protocol":1}`, "displayName is required"},
		"null display name":       {`{"executable":"echo","protocol":1,"displayName":null}`, "displayName is required"},
		"non-string display name": {`{"executable":"echo","protocol":1,"displayName":1}`, canonical},
		"empty display name":      {`{"executable":"echo","protocol":1,"displayName":""}`, canonical},
		"invalid display scheme":  {`{"executable":"echo","protocol":1,"displayName":"sok://sidecar/probe"}`, canonical},
		"invalid display role":    {`{"executable":"echo","protocol":1,"displayName":"soksak://plugin/probe"}`, canonical},
		"extra display path":      {`{"executable":"echo","protocol":1,"displayName":"soksak://sidecar/probe/child"}`, canonical},
		"uppercase display id":    {`{"executable":"echo","protocol":1,"displayName":"soksak://sidecar/Probe"}`, canonical},
	}
	for name, c := range cases {
		// The invalid declaration leaves the sidecar undeclared without failing the construction, and a send to it names
		// the sidecar, its sidecar.json and the reason.
		directory := t.TempDir()
		sidecars, err := host.NewSidecars(support.Declare(directory, c.sidecar), directory)
		if err != nil {
			t.Errorf("%s: the construction failed: %v", name, err)
			continue
		}
		err = sidecars.Send(support.NewFakeOwner("/projects/a"), support.EchoSidecar, "s1", json.RawMessage(`{}`))
		want := "sidecar " + support.EchoSidecar + ": " + filepath.Join(directory, "sidecar.json") + ": " + c.reason
		if err == nil || err.Error() != want {
			t.Errorf("%s: send error = %v, want %q", name, err, want)
		}
		sidecars.Stop()
	}
}

// contract: sidecars.declaration.invalid-sidecar-leaves-others-declared
func TestAnInvalidDeclarationLeavesTheOtherSidecarsDeclared(t *testing.T) {
	const earlier = "@fixture/sidecar-earlier"
	directory := t.TempDir()
	support.Fixture(t, directory, "echo", "ignore-term\non any echo\n")
	// The refused declaration has a folder of its own, so every folder holds one sidecar.
	refusedFolder := t.TempDir()
	declarations := append(support.Declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`),
		host.SidecarDeclaration{Name: earlier, Folder: refusedFolder, Data: []byte(`{"executable":"echo","protocol":1}`)})
	refused := "sidecar " + earlier + ": " + filepath.Join(refusedFolder, "sidecar.json") + ": displayName is required"
	sidecars, err := host.NewSidecars(declarations, directory)
	if err != nil {
		t.Fatal(err)
	}
	defer sidecars.Stop()
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, earlier, "s2", json.RawMessage(`{}`)); err == nil || err.Error() != refused {
		t.Fatalf("send to the refused sidecar = %v, want %q", err, refused)
	}
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if event := owner.Next(t); event.Surface != "s1" {
		t.Fatalf("event = %+v", event)
	}
	// A declaration after the start keeps the valid sidecar running and the invalid one undeclared.
	if err := sidecars.Declare(declarations); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(owner, earlier, "s2", json.RawMessage(`{}`)); err == nil || err.Error() != refused {
		t.Fatalf("send to the refused sidecar after the declaration = %v, want %q", err, refused)
	}
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"next"}`)); err != nil {
		t.Fatal(err)
	}
	if event := owner.Next(t); string(event.Body) != `{"operation":"next"}` {
		t.Fatalf("event = %+v", event)
	}
}

// contract: sidecars.declaration.persistent-requires-config-directory
func TestPersistentTransportRequiresConfigDirectory(t *testing.T) {
	if _, err := host.NewSidecars(support.Declare(t.TempDir(), `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}`), ""); err == nil || !strings.Contains(err.Error(), "persistent transport requires a config directory") {
		t.Fatalf("persistent transport without config = %v", err)
	}
}

// contract: sidecars.persistent.accepts-non-canonical-config-directory
func TestPersistentTransportAcceptsNonCanonicalConfigDirectory(t *testing.T) {
	// filepath.Join removes ".", so the path that is not normalized is built by string concatenation.
	configDirectory := t.TempDir()
	sidecars, err := host.NewSidecars(support.Declare(t.TempDir(), `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}`), configDirectory+string(os.PathSeparator)+".")
	if err != nil {
		t.Fatalf("non-canonical config directory was rejected: %v", err)
	}
	// There is no executable, so the service start fails, and before that the service directory is created under the configuration directory.
	err = sidecars.Send(support.NewFakeOwner("/projects/test"), support.EchoSidecar, "s1", json.RawMessage(`{}`))
	if err == nil || !strings.Contains(err.Error(), "sidecar") {
		t.Fatalf("send = %v, want a sidecar start error", err)
	}
	if info, err := os.Stat(filepath.Join(configDirectory, "services", "echo")); err != nil || !info.IsDir() {
		t.Fatalf("service directory under the config directory: %v", err)
	}
}

// contract: sidecars.send.rejects-when-no-plugin-declares-sidecars
func TestApplicationWithoutSidecarsRejectsSends(t *testing.T) {
	directory := t.TempDir()
	sidecars, err := host.NewSidecars(nil, directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(support.NewFakeOwner("/"), support.EchoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "not declared by any plugin") {
		t.Fatalf("send = %v", err)
	}
}

// contract: sidecars.send.fails-fast-when-sidecar-not-keeping-up, sidecars.send.slow-sidecar-does-not-block-others
func TestSlowSidecarDoesNotBlockOtherSends(t *testing.T) {
	// The slow sidecar does not read stdin, and the other sidecar works normally.
	// When 257 sends go to the slow sidecar, the 256th succeeds and the 257th fails with the "is not keeping up" error.
	// Even when the channel of the slow sidecar is full, Send() to the fast sidecar does not block.

	directory := t.TempDir()

	// The slow sidecar: it does not read stdin, so the pipe fills, and the terminate signal of the stop ends it. A program that reads stdin,
	// such as cat, reads at a speed that depends on the load, so whether the channel fills is not determined.
	slowFolder := t.TempDir()
	support.Fixture(t, slowFolder, "slow", "sleep 600\n")

	// The fast sidecar: it outputs the lines it received as they are.
	fastFolder := t.TempDir()
	support.Fixture(t, fastFolder, "fast", "on any echo\n")

	// Declares the two sidecars.
	sidecars, err := host.NewSidecars([]host.SidecarDeclaration{
		{Name: "@fixture/sidecar-slow", Folder: slowFolder, Data: []byte(`{"executable":"slow","displayName":"soksak://sidecar/probe","protocol":1}`)},
		{Name: "@fixture/sidecar-fast", Folder: fastFolder, Data: []byte(`{"executable":"fast","displayName":"soksak://sidecar/probe","protocol":1}`)},
	}, directory)
	if err != nil {
		t.Fatal(err)
	}

	owner := support.NewFakeOwner("/projects/test")

	// The first Send to the fast sidecar launches that process, so the send of property 1 goes to a running process.
	if err := sidecars.Send(owner, "@fixture/sidecar-fast", "s2", json.RawMessage(`{"data":"start"}`)); err != nil {
		t.Fatalf("fast start: %v", err)
	}

	// Sends to the slow sidecar until the channel is full.
	// Each message is made large to fill the pipe buffer (64KB) quickly.
	largeBody := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	var lastErr error
	sentCount := 0
	for i := 0; i < 500; i++ { // At most 500 attempts
		err := sidecars.Send(owner, "@fixture/sidecar-slow", "s1", largeBody)
		if err != nil {
			lastErr = err
			if strings.Contains(err.Error(), "is not keeping up") {
				break // Confirmed that the channel is full
			}
			t.Fatalf("send %d: unexpected error: %v", i, err)
		}
		sentCount++
	}

	// Checks that the "is not keeping up" error was finally received.
	if lastErr == nil || !strings.Contains(lastErr.Error(), "is not keeping up") {
		t.Fatalf("after %d sends: want 'is not keeping up', got %v", sentCount, lastErr)
	}

	err = lastErr

	// Property 1: even when the channel of the slow sidecar is full, Send() to the fast sidecar does not block. The slow sidecar
	// reads nothing until the stop, so a send that waits for its channel does not return, and the check stops at the limit of its
	// runner.
	if err := sidecars.Send(owner, "@fixture/sidecar-fast", "s2", json.RawMessage(`{"data":"test"}`)); err != nil {
		t.Fatalf("fast send: %v", err)
	}

	// The slow sidecar does not read its input and ends at the terminate signal of the stop.
	sidecars.Stop()
}

// TestStopGracefulShutdown verifies that, when the sidecar actually reads stdin, Stop() ends by the exit of the sidecar at stdin EOF.
// contract: sidecars.stop.graceful-on-stdin-eof
func TestStopGracefulShutdown(t *testing.T) {
	directory := t.TempDir()

	// The sidecar: echoes the lines it received as they are and ends normally at stdin EOF. It ignores the terminate signal of the stop, so
	// it ends by its input.
	support.Fixture(t, directory, "graceful", "ignore-term\non any echo\n")

	// Declares the sidecar.
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"graceful","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}

	owner := support.NewFakeOwner("/projects/test")

	// Starts the sidecar.
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}

	// Checks that the sidecar is actually reading stdin: waits for the echo event.
	if event := owner.Next(t); event.Sidecar != support.EchoSidecar || event.Surface != "s1" {
		t.Fatalf("echo event = %+v", event)
	}

	// The stop ends by the exit of the sidecar at the end of its input; a stop that does not end stops at the limit of the runner.
	sidecars.Stop()
}

// TestStopClosesUnreadOutput verifies that a protocol failure while stopping is written to the log, the read end of the output that the host no longer reads is
// closed, and a sidecar that writes more than the pipe can hold afterward also ends without a forced termination. The output is
// the close reply of a surface that the host did not close. The exit of that process is not reported because it is caused by the closed pipe.
// contract: sidecars.stop.closes-unread-output
func TestStopClosesUnreadOutput(t *testing.T) {
	written := support.CaptureLog(t)
	directory := t.TempDir()
	support.Fixture(t, directory, "talkative", "ignore-term\non any echo\nat-eof flood 3000 "+`{"surface":"s1","closed":true}`+"\n")
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"talkative","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	owner := support.NewFakeOwner("/projects/test")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	if event := owner.Next(t); event.Surface != "s1" {
		t.Fatalf("echo event = %+v", event)
	}
	// A stop that waits on the unread output does not return, and the check stops at the limit of its runner.
	sidecars.Stop()
	logged := written()
	if want := "error host sidecar @fixture/sidecar-echo: failed: unexpected close answer for s1\n"; !strings.Contains(logged, want) {
		t.Errorf("log %q does not contain %q", logged, want)
	}
	if strings.Contains(logged, "exited while stopping") {
		t.Errorf("log %q reports the exit that the closed pipe caused", logged)
	}
}

// TestStopReadsOutputToItsEnd verifies that the host reads the output to the end while stopping. The sidecar answers the close it received before the stop
// only after the input ended, then writes more than the pipe can hold, and records finished only when all writes succeeded.
// This is the same order as the files sidecar answering the closed that a window close sent when the application ends.
// contract: sidecars.stop.reads-output-to-end
func TestStopReadsOutputToItsEnd(t *testing.T) {
	written := support.CaptureLog(t)
	directory := t.TempDir()
	closed := filepath.Join(directory, "closed")
	sidecars := fixtureSidecars(t, directory, "ignore-term\non match *\"closed\":true* keep "+closed+"\non any echo\n"+
		"at-eof write "+`{"surface":"s1","closed":true}`+"\n"+
		"at-eof flood 3000 "+`{"surface":"s1","body":"late"}`+"\n"+
		"at-eof append "+filepath.Join(directory, "finished")+" finished\n")
	owner := support.NewFakeOwner("/projects/test")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	if event := owner.Next(t); event.Surface != "s1" {
		t.Fatalf("echo event = %+v", event)
	}
	sidecars.Close("s1")
	sidecars.Stop()
	// The sidecar writes its answers after the end of its input, so the close it received is recorded before that end.
	if data, err := os.ReadFile(closed); err != nil || !strings.Contains(string(data), `"closed":true`) {
		t.Errorf("the sidecar did not receive the close before the end of its input: closed = %q, %v", data, err)
	}
	if data, err := os.ReadFile(filepath.Join(directory, "finished")); err != nil || string(data) != "finished\n" {
		t.Errorf("the sidecar did not complete its writes on its way out: finished = %q, %v", data, err)
	}
	if logged := written(); strings.Contains(logged, "error host ") {
		t.Errorf("stop logged an error: %q", logged)
	}
}

// TestStopReportsExitStatus verifies that, while stopping, a sidecar that ended with a non-zero exit status or a signal is written to the log in the same form on both
// hosts.
// contract: sidecars.stop.reports-exit-status
func TestStopReportsExitStatus(t *testing.T) {
	written := support.CaptureLog(t)
	for ending, want := range map[string]string{
		"exit 3":     "error host sidecar @fixture/sidecar-echo: exited while stopping: exit status 3\n",
		"signal HUP": "error host sidecar @fixture/sidecar-echo: exited while stopping: signal 1\n",
	} {
		sidecars := fixtureSidecars(t, t.TempDir(), "ignore-term\non any echo\nat-eof "+ending+"\n")
		owner := support.NewFakeOwner("/projects/test")
		if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
			t.Fatalf("send: %v", err)
		}
		if event := owner.Next(t); event.Surface != "s1" {
			t.Fatalf("echo event = %+v", event)
		}
		sidecars.Stop()
		if logged := written(); !strings.Contains(logged, want) {
			t.Errorf("%s: log %q does not contain %q", ending, logged, want)
		}
	}
}

// A sidecar that ignores the end of its input ends at the terminate signal of the stop: the stop ends by that exit, and the host
// writes neither an error line nor an "exited while stopping" line for it.
// contract: sidecars.stop.terminates-the-process-group
func TestAStopTerminatesASidecarThatIgnoresItsInput(t *testing.T) {
	written := support.CaptureLog(t)
	// The sidecar does not read stdin, so it keeps running after stdin EOF; it reads the pipe that the check holds, so it ends
	// with the check also when the check is killed.
	directory := t.TempDir()
	holdPipe(t, filepath.Join(directory, "hold"))
	sidecars := fixtureSidecars(t, directory, "hold "+filepath.Join(directory, "hold")+"\n")
	owner := support.NewFakeOwner("/projects/test")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	// A stop that waits for no exit and kills does not return before the exit, and a stop that waits forever stops at the limit
	// of the runner.
	sidecars.Stop()
	logged := written()
	if strings.Contains(logged, "error host ") || strings.Contains(logged, "exited while stopping") {
		t.Errorf("the stop by the terminate signal wrote %q", logged)
	}
}

// contract: sidecars.close.keeps-other-sessions
func TestClosingASurfaceKeepsOtherSessions(t *testing.T) {
	sidecars, record := echoSidecars(t)
	owner := support.NewFakeOwner("/projects/a")
	for _, surface := range []string{"s1", "state:files:p1"} {
		if err := sidecars.Send(owner, support.EchoSidecar, surface, json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatal(err)
		}
	}
	// The echo is the event that the sidecar ignores the terminate signal of the stop, so it records every line.
	owner.Next(t)
	sidecars.Close("s1")
	// Even after the project of the window left, a session that was not closed sends with the first root.
	owner.Root = ""
	if err := sidecars.Send(owner, support.EchoSidecar, "state:files:p1", json.RawMessage(`{"operation":"watch"}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Stop()
	requests, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}
{"surface":"state:files:p1","root":"/projects/a","body":{"operation":"open"}}
{"surface":"s1","root":"/projects/a","closed":true}
{"surface":"state:files:p1","root":"/projects/a","body":{"operation":"watch"}}
`
	if string(requests) != want {
		t.Fatalf("requests =\n%s\nwant\n%s", requests, want)
	}
}

// contract: sidecars.close.reaches-holding-sidecar
func TestCloseReachesOnlyTheSidecarThatHoldsTheSurface(t *testing.T) {
	directory := t.TempDir()
	makeEcho := func(name string) (string, string) {
		folder := filepath.Join(directory, name)
		if err := os.MkdirAll(folder, 0o755); err != nil {
			t.Fatal(err)
		}
		record := filepath.Join(folder, "requests")
		support.Fixture(t, folder, "echo", "ignore-term\non any tee "+record+"\n")
		return folder, record
	}
	firstFolder, firstRecord := makeEcho("first")
	secondFolder, secondRecord := makeEcho("second")
	const second = "@fixture/sidecar-second"
	declarations := []host.SidecarDeclaration{
		{Name: support.EchoSidecar, Folder: firstFolder, Data: []byte(`{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`)},
		{Name: second, Folder: secondFolder, Data: []byte(`{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`)},
	}
	sidecars, err := host.NewSidecars(declarations, directory)
	if err != nil {
		t.Fatal(err)
	}
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(owner, second, "s2", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	// The echo of each sidecar is the event that it ignores the terminate signal of the stop, so it records every line. The two
	// sidecars answer in either order, so the check takes both events and requires the echo of the open of each.
	echoes := map[string]string{}
	for range 2 {
		event := owner.Next(t)
		echoes[event.Sidecar] = event.Surface + " " + string(event.Body)
	}
	if want := map[string]string{support.EchoSidecar: `s1 {"operation":"open"}`, second: `s2 {"operation":"open"}`}; !reflect.DeepEqual(echoes, want) {
		t.Fatalf("the echoes are %v, want %v", echoes, want)
	}
	sidecars.Close("s1")
	sidecars.Stop()
	// Only the sidecar that received s1 is told that it closed; the other sidecar gets no closed notice for it.
	first, err := os.ReadFile(firstRecord)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}
{"surface":"s1","root":"/projects/a","closed":true}
`; string(first) != want {
		t.Fatalf("first sidecar requests =\n%s\nwant\n%s", first, want)
	}
	secondRequests, err := os.ReadFile(secondRecord)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"surface":"s2","root":"/projects/a","body":{"operation":"open"}}
`; string(secondRequests) != want {
		t.Fatalf("second sidecar requests =\n%s\nwant\n%s", secondRequests, want)
	}
}

// closingSnapshots is a channel that receives the value of closing every time closing changes.
func closingSnapshots(sidecars *host.Sidecars) chan []host.ClosingSurface {
	snapshots := make(chan []host.ClosingSurface, 64)
	sidecars.ClosingChanged = func(value host.SidecarStatus) { snapshots <- value.Closing }
	return snapshots
}

// nextClosing receives the next closing value. If none arrives, the check fails.
func nextClosing(t *testing.T, snapshots chan []host.ClosingSurface) []host.ClosingSurface {
	t.Helper()
	value := <-snapshots
	return value
}

// closingSidecars declares a sidecar of the sidecar fixture in a folder of its own, which runs the control text control.
func closingSidecars(t *testing.T, control string) *host.Sidecars {
	t.Helper()
	return fixtureSidecars(t, t.TempDir(), control)
}

// contract: sidecars.close.answer-ends-closing
func TestClosedSurfaceStaysClosingUntilTheSidecarAnswers(t *testing.T) {
	// Returns the line it received as it is. Returning a closed line is the reply to closed.
	sidecars := closingSidecars(t, "on any echo\n")
	snapshots := closingSnapshots(sidecars)
	owner := support.NewFakeOwner("/projects/closing")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s1")
	want := []host.ClosingSurface{{Sidecar: support.EchoSidecar, Surface: "s1"}}
	if got := nextClosing(t, snapshots); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("closing after close = %v, want %v", got, want)
	}
	if got := nextClosing(t, snapshots); len(got) != 0 {
		t.Fatalf("closing after the answer = %v, want none", got)
	}
}

// contract: sidecars.close.failed-answer-is-logged
func TestFailedCloseAnswerIsLogged(t *testing.T) {
	sidecars := closingSidecars(t, "on match *closed* reply "+`{"surface":"s1","closed":true,"error":"busy"}`+"\non any echo\n")
	snapshots := closingSnapshots(sidecars)
	written := support.CaptureLog(t)
	owner := support.NewFakeOwner("/projects/closing")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s1")
	nextClosing(t, snapshots)
	if got := nextClosing(t, snapshots); len(got) != 0 {
		t.Fatalf("closing after the failed answer = %v, want none", got)
	}
	if want := "error host sidecar @fixture/sidecar-echo: close s1: busy\n"; !strings.Contains(written(), want) {
		t.Fatalf("log %q does not contain %q", written(), want)
	}
}

// The log holds the failure when the closing entry ends, so a reader of the log after that status finds it.
// contract: sidecars.close.failed-answer-is-logged
func TestFailedCloseAnswerIsLoggedBeforeTheClosingEntryEnds(t *testing.T) {
	sidecars := closingSidecars(t, "on match *closed* reply "+`{"surface":"s1","closed":true,"error":"busy"}`+"\non any drop\n")
	written := support.CaptureLog(t)
	atEnd := make(chan string, 1)
	sidecars.ClosingChanged = func(value host.SidecarStatus) {
		if len(value.Closing) == 0 {
			atEnd <- written()
		}
	}
	owner := support.NewFakeOwner("/projects/closing")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s1")
	log := <-atEnd
	if want := "error host sidecar @fixture/sidecar-echo: close s1: busy\n"; !strings.Contains(log, want) {
		t.Fatalf("log at the end of the closing entry %q does not contain %q", log, want)
	}
}

// contract: sidecars.close.unexpected-answer-fails
func TestCloseAnswerForAnOpenSurfaceFailsTheSidecar(t *testing.T) {
	sidecars := closingSidecars(t, "on 1 reply "+`{"surface":"s1","closed":true}`+"\non any drop\n")
	owner := support.NewFakeOwner("/projects/closing")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	failure := <-owner.Failures
	if got := failure.(host.SidecarFailure).Reason; got != "unexpected close answer for s1" {
		t.Fatalf("failure reason = %q", got)
	}
}

// contract: sidecars.declaration.replaces-changed-folder
func TestDeclarationReplacesASidecarWhoseFolderChanged(t *testing.T) {
	// Each folder holds a sidecar that answers every request with the name of its folder.
	folder := func(name string) string {
		directory := filepath.Join(t.TempDir(), name)
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
		support.Fixture(t, directory, "answer", "on any reply "+`{"surface":"s1","body":{"from":"`+name+`"}}`+"\n")
		return directory
	}
	data := `{"executable":"answer","displayName":"soksak://sidecar/probe","protocol":1}`
	first, second := folder("first"), folder("second")
	sidecars, err := host.NewSidecars(support.Declare(first, data), "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	owner := support.NewFakeOwner("/projects/replace")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	if got := string(owner.Next(t).Body); got != `{"from":"first"}` {
		t.Fatalf("the first answer = %s", got)
	}
	if err := sidecars.Declare(support.Declare(second, data)); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"data":2}`)); err != nil {
		t.Fatal(err)
	}
	if got := string(owner.Next(t).Body); got != `{"from":"second"}` {
		t.Fatalf("the answer after the folder changed = %s, want the sidecar of the new folder", got)
	}
	select {
	case failure := <-owner.Failures:
		t.Fatalf("replacing the sidecar reported a failure: %v", failure)
	default:
	}
}

// contract: sidecars.close.repeated-close-awaits-each-answer
func TestRepeatedCloseAwaitsEachAnswer(t *testing.T) {
	// The sidecar echoes requests and answers both closes of s1 after it has received the second one.
	// The closes are the second and the fourth input lines. The fourth one gets the answer twice, as the second close of s1.
	sidecars := closingSidecars(t, "on 2 drop\non 4 flood 2 "+`{"surface":"s1","closed":true}`+"\non any echo\n")
	snapshots := closingSnapshots(sidecars)
	var written strings.Builder
	var mu sync.Mutex
	log.SetOutput(writerFunc(func(p []byte) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		return written.Write(p)
	}))
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	owner := support.NewFakeOwner("/projects/closing")
	for round := 0; round < 2; round++ {
		if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
			t.Fatal(err)
		}
		owner.Next(t)
		sidecars.Close("s1")
		nextClosing(t, snapshots)
	}
	for len(nextClosing(t, snapshots)) != 0 {
	}
	// The echo of a later request follows both answers in the output, so a failure of either answer arrives first.
	if err := sidecars.Send(owner, support.EchoSidecar, "s2", json.RawMessage(`{"data":2}`)); err != nil {
		t.Fatal(err)
	}
	owner.Next(t)
	mu.Lock()
	defer mu.Unlock()
	if strings.Contains(written.String(), "failed") {
		t.Fatalf("the second answer of a repeated close failed the sidecar: %q", written.String())
	}
}

// contract: sidecars.close.process-end-clears-closing
func TestEndedSidecarLeavesNoClosingSurface(t *testing.T) {
	// Replies to the first request, and when it receives closed, it ends without a reply.
	sidecars := closingSidecars(t, "on 1 echo\non 2 exit 0\n")
	snapshots := closingSnapshots(sidecars)
	owner := support.NewFakeOwner("/projects/closing")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s1")
	if got := nextClosing(t, snapshots); len(got) != 1 {
		t.Fatalf("closing after close = %v, want s1", got)
	}
	if got := nextClosing(t, snapshots); len(got) != 0 {
		t.Fatalf("closing after the sidecar ended = %v, want none", got)
	}
}

// writerFunc uses a function as an io.Writer.
type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// A sidecar of standard input and output may write any text to its standard error: the host writes each line as a
// record of level info, layer sidecar and the name of the sidecar, and the last text without a line feed too.
// contract: sidecars.stderr.lines-are-written-as-records
func TestTheStandardErrorOfASidecarIsWrittenAsRecords(t *testing.T) {
	written := support.CaptureLog(t)
	sidecars := fixtureSidecars(t, t.TempDir(), "stderr first line\nstderr-raw no line feed\non any echo\n")
	owner := support.NewFakeOwner("/projects/test")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	if event := owner.Next(t); event.Surface != "s1" {
		t.Fatalf("echo event = %+v", event)
	}
	sidecars.Stop()
	logged := written()
	for _, want := range []string{" info sidecar @fixture/sidecar-echo: first line\n", " info sidecar @fixture/sidecar-echo: no line feed\n"} {
		if !strings.Contains(logged, want) {
			t.Errorf("log %q does not contain %q", logged, want)
		}
	}
}

// Every request that the host sends to a sidecar and every message that it receives is a trace event with its whole body,
// in the order of the relay (docs/spec/diagnostics.md).
// contract: sidecars.trace.relay-records-every-message-with-its-body
func TestTheRelayRecordsEveryMessageWithItsWholeBody(t *testing.T) {
	// The text is written as a JSON escape of one code point, so the relay decodes it.
	sidecars := fixtureSidecars(t, t.TempDir(), `on 1 reply {"surface":"s1","body":{"event":"state","text":"\`+`ud55c"}}`+"\non any drop\n")
	log := support.UseEventLog(t)
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = host.PerformanceCommand(map[string]any{"action": "off"}) })
	owner := support.NewFakeOwner("/projects/test")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"input","bytes":"7ZWc"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	if event := owner.Next(t); event.Surface != "s1" {
		t.Fatalf("event = %+v", event)
	}
	sidecars.Stop()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var sent, received map[string]any
	for _, record := range readEventLog(t, log.Path()) {
		switch record["event"] {
		case "host.trace.sidecar.send":
			sent = record
		case "host.trace.sidecar.receive":
			received = record
		}
	}
	if sent == nil || sent["layer"] != "host" || sent["fields"].(map[string]any)["sidecar"] != support.EchoSidecar || sent["fields"].(map[string]any)["surface"] != "s1" {
		t.Fatalf("the request was not recorded: %v", sent)
	}
	if body, _ := sent["fields"].(map[string]any)["body"].(map[string]any); body["operation"] != "input" || body["bytes"] != "7ZWc" {
		t.Fatalf("the request body was not recorded whole: %v", sent["fields"])
	}
	if received == nil || received["fields"].(map[string]any)["surface"] != "s1" {
		t.Fatalf("the message was not recorded: %v", received)
	}
	if body, _ := received["fields"].(map[string]any)["body"].(map[string]any); body["event"] != "state" || body["text"] != "한" {
		t.Fatalf("the message body was not recorded whole: %v", received["fields"])
	}
}

// contract: sidecars.protocol.request-with-cids-is-recorded
func TestSidecarRequestWithCorrelationIdentifiersIsRecordedAsAnEvent(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	sidecars, _ := echoSidecars(t)
	owner := support.NewFakeOwner("/projects/a")
	body := json.RawMessage(`{"operation":"input"}`)
	if err := sidecars.SendWithCids(owner, support.EchoSidecar, "s1", body, []string{"b1.7", "b1.8"}); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", body); err != nil {
		t.Fatal(err)
	}
	owner.Next(t)
	owner.Next(t)
	sidecars.Stop()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var requests []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] == "host.sidecar.request" {
			requests = append(requests, event)
		}
	}
	if len(requests) != 1 {
		t.Fatalf("a request with identifiers and one without stored %d requests, want 1: %v", len(requests), requests)
	}
	request := requests[0]
	cids, ok := request["cids"].([]any)
	fields := request["fields"].(map[string]any)
	if request["level"] != "info" || !ok || len(cids) != 2 || cids[0] != "b1.7" || cids[1] != "b1.8" ||
		fields["name"] != support.EchoSidecar || fields["surface"] != "s1" || fields["bytes"] != float64(len(body)) {
		t.Fatalf("the request record: %v", request)
	}
}

// sidecarReplies flushes the writer and returns the events `host.sidecar.reply` that it stored.
func sidecarReplies(t *testing.T, log *host.EventLog, config string) []map[string]any {
	t.Helper()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var replies []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] == "host.sidecar.reply" {
			replies = append(replies, event)
		}
	}
	return replies
}

// replySidecars declares a sidecar that answers the first two requests with their replies. The third request gets the reply of its
// request and then the state event, which the replies file of the folder holds as data.
func replySidecars(t *testing.T) *host.Sidecars {
	t.Helper()
	directory := t.TempDir()
	replies := filepath.Join(directory, "replies")
	if err := os.WriteFile(replies, []byte(`{"surface":"s1","body":{"id":3,"error":{"reason":"no request"}}}`+"\n"+
		`{"surface":"s1","body":{"event":"state"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return fixtureSidecars(t, directory, `on 1 reply {"surface":"s1","cids":["b1.7","b1.8"],"body":{"id":1,"error":"unsupported operation"}}`+"\n"+
		`on 2 reply {"surface":"s1","cids":["b1.9"],"body":{"id":2,"ok":true}}`+"\n"+
		"on 3 then hold "+replies+"\non any drop\n")
}

// contract: sidecars.protocol.reply-cids-reach-the-owner
func TestAMessageOfASidecarReachesItsOwnerWithTheIdentifiersOfItsRequest(t *testing.T) {
	// The replies are records: without a writer of this test the host holds them for the writer of the next test.
	support.StartWriter(t, t.TempDir())
	sidecars := replySidecars(t)
	owner := support.NewFakeOwner("/projects/a")
	body := json.RawMessage(`{"operation":"input"}`)
	if err := sidecars.SendWithCids(owner, support.EchoSidecar, "s1", body, []string{"b1.7", "b1.8"}); err != nil {
		t.Fatal(err)
	}
	if got := owner.Next(t).Cids; fmt.Sprint(got) != "[b1.7 b1.8]" {
		t.Fatalf("the message names %v, want both identifiers of its request", got)
	}
	if err := sidecars.SendWithCids(owner, support.EchoSidecar, "s1", body, []string{"b1.9"}); err != nil {
		t.Fatal(err)
	}
	if got := owner.Next(t).Cids; fmt.Sprint(got) != "[b1.9]" {
		t.Fatalf("the message names %v, want the identifier of its request", got)
	}
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", body); err != nil {
		t.Fatal(err)
	}
	if got := owner.Next(t).Cids; len(got) != 0 {
		t.Fatalf("a message without identifiers names %v", got)
	}
}

// contract: sidecars.protocol.reply-with-cids-is-recorded
func TestAReplyOfASidecarIsRecordedWithTheIdentifiersOfItsRequest(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	sidecars := replySidecars(t)
	owner := support.NewFakeOwner("/projects/a")
	body := json.RawMessage(`{"operation":"input"}`)
	if err := sidecars.SendWithCids(owner, support.EchoSidecar, "s1", body, []string{"b1.7", "b1.8"}); err != nil {
		t.Fatal(err)
	}
	owner.Next(t)
	if err := sidecars.SendWithCids(owner, support.EchoSidecar, "s1", body, []string{"b1.9"}); err != nil {
		t.Fatal(err)
	}
	owner.Next(t)
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", body); err != nil {
		t.Fatal(err)
	}
	owner.Next(t)
	owner.Next(t)
	replies := sidecarReplies(t, log, config)
	if len(replies) != 3 {
		t.Fatalf("%d events host.sidecar.reply, want 3 (an error with identifiers, an answer with identifiers, an error without): %v", len(replies), replies)
	}
	want := []struct {
		level, error string
		ok           bool
		cids         []any
		micros       bool
	}{
		{"warn", "-32603: unsupported operation", false, []any{"b1.7", "b1.8"}, true},
		{"info", "", true, []any{"b1.9"}, true},
		{"warn", `-32603: {"reason":"no request"}`, false, nil, false},
	}
	for i, w := range want {
		fields := replies[i]["fields"].(map[string]any)
		cids, _ := replies[i]["cids"].([]any)
		_, hasMicros := fields["micros"]
		errorText, _ := fields["error"].(string)
		if replies[i]["level"] != w.level || fields["name"] != support.EchoSidecar || fields["surface"] != "s1" || fields["ok"] != w.ok ||
			errorText != w.error || fmt.Sprint(cids) != fmt.Sprint(w.cids) || hasMicros != w.micros {
			t.Fatalf("reply %d is %v, want level %s ok %v error %q cids %v micros %v", i, replies[i], w.level, w.ok, w.error, w.cids, w.micros)
		}
		if hasMicros && fields["micros"].(float64) < 0 {
			t.Fatalf("reply %d has micros %v", i, fields["micros"])
		}
	}
}

// contract: sidecars.protocol.failure-fails-the-pending-requests
func TestTheFailureOfASidecarIsTheFailedReplyOfItsPendingRequests(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	sidecars := fixtureSidecars(t, t.TempDir(), "on 1 drop\non 2 exit 3\n")
	owner := support.NewFakeOwner("/projects/a")
	body := json.RawMessage(`{"operation":"input"}`)
	if err := sidecars.SendWithCids(owner, support.EchoSidecar, "s1", body, []string{"b1.7"}); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.SendWithCids(owner, support.EchoSidecar, "s1", body, []string{"b1.8"}); err != nil {
		t.Fatal(err)
	}
	failure := owner.Failure(t)
	replies := sidecarReplies(t, log, config)
	if len(replies) != 1 {
		t.Fatalf("%d events host.sidecar.reply, want 1: %v", len(replies), replies)
	}
	fields := replies[0]["fields"].(map[string]any)
	cids, _ := replies[0]["cids"].([]any)
	if replies[0]["level"] != "warn" || fields["ok"] != false || fields["error"] != "-32603: "+failure.Reason || fields["surface"] != "s1" ||
		fields["bytes"] != float64(0) || fmt.Sprint(cids) != "[b1.7 b1.8]" {
		t.Fatalf("reply %v, failure %+v", replies[0], failure)
	}
}

// contract: sidecars.lifetime.start-and-exit-events
func TestSidecarLifetimeIsRecordedAsEvents(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	// The first process ends by itself with a status; the second ends when the host stops it.
	// The second process ignores the terminate signal of the stop, so it ends with its input and its status is 0.
	// The second process answers its first line after it set the trap, so the answer is the event that it ignores the signal.
	directory := t.TempDir()
	ran := filepath.Join(directory, "ran")
	// The first process ends at its first line. The second process has the ran file, so it jumps to the label after the exit.
	sidecars := fixtureSidecars(t, directory, "if-present "+ran+" second\ntouch "+ran+"\nskip-line\nexit 3\nlabel second\nignore-term\n"+
		`on 1 reply {"surface":"s2","body":"trapped"}`+"\non any drop\n")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	owner.Failure(t)
	if err := sidecars.Send(owner, support.EchoSidecar, "s2", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	owner.Next(t)
	sidecars.Stop()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var seen []string
	pids := map[string]bool{}
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		name, _ := event["event"].(string)
		if name != "host.sidecar.start" && name != "host.sidecar.exit" {
			continue
		}
		fields := event["fields"].(map[string]any)
		if fields["name"] != support.EchoSidecar {
			t.Fatalf("%s fields = %v", name, fields)
		}
		pid, ok := fields["pid"].(float64)
		if !ok || pid <= 0 {
			t.Fatalf("%s pid = %v", name, fields["pid"])
		}
		pids[fmt.Sprint(pid)] = true
		status, _ := fields["status"].(string)
		seen = append(seen, name+" "+status)
	}
	want := []string{"host.sidecar.start ", "host.sidecar.exit exit status 3", "host.sidecar.start ", "host.sidecar.exit exit status 0"}
	if strings.Join(seen, "|") != strings.Join(want, "|") || len(pids) != 2 {
		t.Fatalf("lifetime events = %q (%d processes), want %q (2 processes)", seen, len(pids), want)
	}
}

// contract: performance.sampler.names-the-sidecar-processes
func TestTheSamplerNamesARunningSidecarUntilItEnds(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	t.Cleanup(func() { _, _ = host.PerformanceCommand(map[string]any{"action": "off"}) })
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	samples := func(named bool) int {
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		count := 0
		for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
			if event["event"] != "host.sampler.memory" {
				continue
			}
			if _, has := event["fields"].(map[string]any)["name"]; has == named {
				count++
			}
		}
		return count
	}
	// The sampler stores a first sample of the host when it starts; the check waits for it and sets an interval of an hour, so
	// that no sample of the sampler runs among the samples below.
	waitForFirstSample(t)
	sidecars := fixtureSidecars(t, t.TempDir(), "on any drop\n")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	host.PerformanceSample()
	// The order of the records states the contract: a sample names the sidecar while it runs, and none names it after its exit
	// record.
	if got := samples(true); got != 1 {
		t.Fatalf("a running sidecar was named by %d samples, want 1", got)
	}
	sidecars.Stop()
	host.PerformanceSample()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	exit, named := -1, []int{}
	for index, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		fields, _ := event["fields"].(map[string]any)
		if event["event"] == "host.sidecar.exit" && fields["name"] == support.EchoSidecar {
			exit = index
		}
		if event["event"] == "host.sampler.memory" && fields["name"] == support.EchoSidecar {
			named = append(named, index)
		}
	}
	if exit < 0 || len(named) == 0 {
		t.Fatalf("the sidecar has an exit record at %d and %d samples that name it", exit, len(named))
	}
	for _, index := range named {
		if index > exit {
			t.Fatalf("a sample names the sidecar after it ended: samples at %v, exit at %d", named, exit)
		}
	}
}

// contract: sidecars.protocol.request-line-carries-cids
func TestSidecarRequestCarriesTheCorrelationIdentifiers(t *testing.T) {
	sidecars, record := echoSidecars(t)
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.SendWithCids(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"input"}`), []string{"b1.7", "b1.8"}); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"input"}`)); err != nil {
		t.Fatal(err)
	}
	owner.Next(t)
	owner.Next(t)
	sidecars.Stop()
	requests, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"surface":"s1","root":"/projects/a","cids":["b1.7","b1.8"],"body":{"operation":"input"}}
{"surface":"s1","root":"/projects/a","body":{"operation":"input"}}
`
	if string(requests) != want {
		t.Fatalf("requests =\n%s\nwant\n%s", requests, want)
	}
}

// contract: sidecars.image.closed-surface-is-answered, sidecars.image.retired-owner-dispositions
func TestAnImageOfAClosedSurfaceIsAnsweredClosed(t *testing.T) {
	support.CaptureLog(t)
	// The sidecar sends a transfer image of the closed surface s2, reads the answer of the host and returns it as a message of s1.
	directory := t.TempDir()
	sidecars := fixtureSidecars(t, directory, "record-pid "+filepath.Join(directory, "pid")+"\non 1 drop\non 2 drop\n"+
		`on 3 reply {"surface":"s2","body":{"image":{"format":"bgra8","generation":3,"height":10,"name":"view","raster":4,"scale":1.0,"sequence":5,"token":{"id":7,"kind":"iosurface-global"},"width":10}}}`+
		"\non 4 reply-raw s1\non any drop\n")
	owner := support.NewFakeOwner("/projects/a")
	for _, surface := range []string{"s1", "s2"} {
		if err := sidecars.Send(owner, support.EchoSidecar, surface, json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatal(err)
		}
	}
	sidecars.Close("s2")
	event := owner.Next(t)
	var answer any
	if err := json.Unmarshal(event.Body, &answer); err != nil {
		t.Fatalf("the returned answer %s is not JSON: %v", event.Body, err)
	}
	want := map[string]any{"surface": "s2", "body": map[string]any{"image": map[string]any{
		"error": "closed", "name": "view", "generation": float64(3), "raster": float64(4), "sequence": float64(5)}}}
	if event.Surface != "s1" || !reflect.DeepEqual(answer, want) {
		t.Fatalf("the host answered %s for the image of the closed surface; want %v", event.Body, want)
	}
	// The sidecar ends at its stop, which ends by that exit; a stop that does not end stops at the limit of the runner.
	sidecars.Stop()
}

// contract: sidecars.read.unfinished-line-ends-the-connection
func TestAnUnfinishedLineAtTheEndOfTheOutputIsNotAMessage(t *testing.T) {
	unfinished := 0
	scanner := bufio.NewScanner(strings.NewReader("{\"surface\":\"s1\"}\r\n{\"surface\":\"s2\",\"body\":\"cut"))
	scanner.Split(host.MessageLines(&unfinished))
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0] != `{"surface":"s1"}` {
		t.Fatalf("lines %q, want only the complete line", lines)
	}
	if unfinished != len(`{"surface":"s2","body":"cut`) {
		t.Fatalf("unfinished %d, want the bytes of the line that the process did not finish", unfinished)
	}
}

// A response to a sidecar that has ended has no receiver: its frames ended with its process, so the dropped-message path
// records the answer that it cannot send instead of an error.
// contract: sidecars.protocol.answer-to-ended-sidecar-is-recorded
func TestAResponseToASidecarThatEndedIsTheEndedError(t *testing.T) {
	sidecars := fixtureSidecars(t, t.TempDir(), "sleep 600\n")
	err := sidecars.SendResponse(support.EchoSidecar, "s1", "view", json.RawMessage(`{"image":{"error":"closed"}}`))
	if !errors.Is(err, host.ErrSidecarEnded) || err.Error() != "sidecar "+support.EchoSidecar+" is not running" {
		t.Fatalf("err %v", err)
	}
}

// contract: sidecars.lifetime.first-output-after-spawn-is-recorded
func TestStandardIOSidecarFirstAnswerAfterSpawnIsRecorded(t *testing.T) {
	directory := t.TempDir()
	sidecars := fixtureSidecars(t, directory, "record-pid "+filepath.Join(directory, "pid")+"\n"+
		`on 1 reply {"surface":"s1","body":{"event":"state"}}`+"\non any drop\n")
	log := support.UseEventLog(t)
	owner := support.NewFakeOwner("/projects/test")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"input"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	owner.Next(t)
	sidecars.Stop()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	pid := float64(support.ProcessID(t, directory))
	var start, first map[string]any
	for _, record := range readEventLog(t, log.Path()) {
		switch record["event"] {
		case "host.sidecar.start":
			start = record
		case "host.sidecar.first_output":
			first = record
		}
	}
	if start == nil {
		t.Fatal("the start of the sidecar process was not recorded")
	}
	if first == nil {
		t.Fatal("the first output after the spawn was not recorded")
	}
	startFields, _ := start["fields"].(map[string]any)
	if startFields["name"] != support.EchoSidecar || startFields["pid"] != pid {
		t.Fatalf("start event = %v, want the sidecar and pid %v", start, pid)
	}
	if first["level"] != "info" {
		t.Fatalf("first output event = %v, want level info", first)
	}
	fields, _ := first["fields"].(map[string]any)
	if fields["name"] != support.EchoSidecar || fields["pid"] != pid {
		t.Fatalf("first output event = %v, want the sidecar and pid %v", first, pid)
	}
	if ms, ok := fields["ms"].(float64); !ok || ms < 0 {
		t.Fatalf("ms = %v, want a number of milliseconds from the spawn", fields["ms"])
	}
	startSeq, okStart := start["seq"].(float64)
	firstSeq, okFirst := first["seq"].(float64)
	if !okStart || !okFirst || firstSeq <= startSeq {
		t.Fatalf("first output seq %v is not after the start seq %v", first["seq"], start["seq"])
	}
}

// contract: sidecars.lifetime.first-output-after-spawn-is-recorded
func TestSidecarWithoutAnswerRecordsStartAndNoFirstOutput(t *testing.T) {
	sidecars := fixtureSidecars(t, t.TempDir(), "on any drop\n")
	log := support.UseEventLog(t)
	owner := support.NewFakeOwner("/projects/test")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"input"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	sidecars.Stop()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var start map[string]any
	for _, record := range readEventLog(t, log.Path()) {
		switch record["event"] {
		case "host.sidecar.start":
			start = record
		case "host.sidecar.first_output":
			t.Fatalf("a sidecar that wrote no line has the first output event %v", record)
		}
	}
	if start == nil {
		t.Fatal("the start of the sidecar process was not recorded")
	}
}

// restartEpoch is the time at offset zero of the restart-limit checks.
var restartEpoch = time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)

// restartClock is the clock that a restart-limit check injects into the channel. It moves only when the check sets it.
type restartClock struct {
	mu  sync.Mutex
	now time.Time
}

// set moves the clock to offset after restartEpoch.
func (c *restartClock) set(offset time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = restartEpoch.Add(offset)
}

// read returns the time of the clock.
func (c *restartClock) read() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// restartControl is the control text of a sidecar that fails on each request with an invalid message, unless the file ok exists in
// its folder; then it answers its first request with that request and runs. The file is checked when the process starts.
func restartControl(directory string) string {
	return "if-absent " + filepath.Join(directory, "ok") + " notok\necho-line\nsleep 600\nlabel notok\nskip-line\nwrite not json\nsleep 600\n"
}

// restartSidecars declares the sidecar of restartControl, which plugin-a lists in dependencies, with an injected clock.
func restartSidecars(t *testing.T) (*host.Sidecars, string, *restartClock) {
	t.Helper()
	directory := t.TempDir()
	support.Fixture(t, directory, "fixture", restartControl(directory))
	declarations := []host.SidecarDeclaration{{Name: support.EchoSidecar, Folder: directory, Data: []byte(`{"executable":"fixture","displayName":"soksak://sidecar/probe","protocol":1}`), Dependents: []string{"plugin-a"}}}
	sidecars, err := host.NewSidecars(declarations, directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	clock := &restartClock{}
	sidecars.Now = clock.read
	return sidecars, directory, clock
}

// sendAt moves the clock to offset and sends an open request of surface from owner.
func sendAt(t *testing.T, clock *restartClock, sidecars *host.Sidecars, owner *support.FakeOwner, surface string, offset time.Duration) error {
	t.Helper()
	clock.set(offset)
	return sidecars.Send(owner, support.EchoSidecar, surface, json.RawMessage(`{"operation":"open"}`))
}

// touchFile creates the empty file name in directory.
func touchFile(t *testing.T, directory, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(directory, name), nil, 0o644); err != nil {
		t.Fatal(err)
	}
}

// requireInvalidFailure waits for the next failure of the owner and checks that the sidecar failed with an invalid message.
func requireInvalidFailure(t *testing.T, owner *support.FakeOwner, offset time.Duration) {
	t.Helper()
	if failure := owner.Failure(t); failure.Sidecar != support.EchoSidecar || failure.Surface != "s1" || !strings.Contains(failure.Reason, "invalid message") {
		t.Fatalf("failure at %v = %+v", offset, failure)
	}
}

// requireRestartLimit checks that err is the refusal of a sidecar at its restart limit.
func requireRestartLimit(t *testing.T, err error, offset time.Duration) {
	t.Helper()
	if err == nil || err.Error() != "sidecar "+support.EchoSidecar+": restart limit" {
		t.Fatalf("send at %v = %v, want the restart limit refusal", offset, err)
	}
}

// contract: sidecars.restart.three-failures-restart
func TestSidecarRestartsAfterThreeFailuresWithinTheWindow(t *testing.T) {
	sidecars, directory, clock := restartSidecars(t)
	owner := support.NewFakeOwner("/projects/a")
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second} {
		if err := sendAt(t, clock, sidecars, owner, "s1", offset); err != nil {
			t.Fatalf("send at %v: %v", offset, err)
		}
		requireInvalidFailure(t, owner, offset)
	}
	// After three failures within 300 seconds the next send starts a process, which runs without failing.
	touchFile(t, directory, "ok")
	if err := sendAt(t, clock, sidecars, owner, "s1", 30*time.Second); err != nil {
		t.Fatalf("send after three failures: %v", err)
	}
	// The answer comes after the check of the file, so the restarted process writes no invalid message after it, and a failure
	// that its start caused is delivered before it.
	owner.Next(t)
	select {
	case value := <-owner.Failures:
		t.Fatalf("the restarted sidecar failed: %+v", value)
	default:
	}
	// The restarted sidecar does not read its input and ends at the terminate signal of the stop.
	sidecars.Stop()
}

// contract: sidecars.restart.fourth-failure-stops
func TestSidecarStopsAtTheFourthFailureWithinTheWindow(t *testing.T) {
	sidecars, _, clock := restartSidecars(t)
	log := support.UseEventLog(t)
	owner := support.NewFakeOwner("/projects/a")
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second, 30 * time.Second} {
		if err := sendAt(t, clock, sidecars, owner, "s1", offset); err != nil {
			t.Fatalf("send at %v: %v", offset, err)
		}
		requireInvalidFailure(t, owner, offset)
	}
	// The fourth failure stops the restarts: the next send starts no process and fails with the reason restart limit.
	requireRestartLimit(t, sendAt(t, clock, sidecars, owner, "s1", 40*time.Second), 40*time.Second)
	if failure := owner.Failure(t); failure.Sidecar != support.EchoSidecar || failure.Surface != "s1" || failure.Reason != "restart limit" {
		t.Fatalf("refused send failure = %+v", failure)
	}
	sidecars.Stop()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	starts, stops := 0, 0
	for _, event := range readEventLog(t, log.Path()) {
		switch event["event"] {
		case "host.sidecar.start":
			starts++
		case "host.sidecar.restart-limit":
			stops++
			if event["level"] != "error" || event["fields"].(map[string]any)["sidecar"] != support.EchoSidecar {
				t.Fatalf("restart-limit event = %v", event)
			}
		}
	}
	if starts != 4 || stops != 1 {
		t.Fatalf("starts = %d, restart-limit events = %d; want 4 and 1", starts, stops)
	}
}

// contract: sidecars.restart.old-failure-not-counted
func TestSidecarCountsOnlyFailuresWithinTheWindow(t *testing.T) {
	sidecars, _, clock := restartSidecars(t)
	owner := support.NewFakeOwner("/projects/a")
	// The failure at 0 seconds is more than 300 seconds before the failure at 305 seconds, so it is not counted there.
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second, 305 * time.Second} {
		if err := sendAt(t, clock, sidecars, owner, "s1", offset); err != nil {
			t.Fatalf("send at %v: %v", offset, err)
		}
		requireInvalidFailure(t, owner, offset)
	}
	// At 305 seconds three failures are counted, so the send at 306 seconds starts a process; its failure is the fourth counted.
	if err := sendAt(t, clock, sidecars, owner, "s1", 306*time.Second); err != nil {
		t.Fatalf("send at 306s: %v", err)
	}
	requireInvalidFailure(t, owner, 306*time.Second)
	requireRestartLimit(t, sendAt(t, clock, sidecars, owner, "s1", 307*time.Second), 307*time.Second)
	if failure := owner.Failure(t); failure.Reason != "restart limit" {
		t.Fatalf("refused send failure = %+v", failure)
	}
}

// contract: sidecars.restart.surface-open-resets-the-record
func TestSurfaceOpenClearsTheRestartLimit(t *testing.T) {
	sidecars, directory, clock := restartSidecars(t)
	log := support.UseEventLog(t)
	support.TraceOn(t)
	owner := support.NewFakeOwner("/projects/a")
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second, 30 * time.Second} {
		if err := sendAt(t, clock, sidecars, owner, "s1", offset); err != nil {
			t.Fatalf("send at %v: %v", offset, err)
		}
		requireInvalidFailure(t, owner, offset)
	}
	requireRestartLimit(t, sendAt(t, clock, sidecars, owner, "s1", 40*time.Second), 40*time.Second)
	owner.Failure(t)
	// The creation of a surface of a plugin that does not list the sidecar leaves the stop in place.
	sidecars.SurfaceOpened("plugin-b", "s2")
	requireRestartLimit(t, sendAt(t, clock, sidecars, owner, "s2", 41*time.Second), 41*time.Second)
	owner.Failure(t)
	// The creation of a surface of plugin-a, which lists the sidecar, clears the record; the next send starts the process.
	touchFile(t, directory, "ok")
	sidecars.SurfaceOpened("plugin-a", "s2")
	if err := sendAt(t, clock, sidecars, owner, "s2", 42*time.Second); err != nil {
		t.Fatalf("send of the opened surface: %v", err)
	}
	if err := sendAt(t, clock, sidecars, owner, "s1", 43*time.Second); err != nil {
		t.Fatalf("send of the refused surface after the reset: %v", err)
	}
	// The restarted sidecar does not read its input and ends at the terminate signal of the stop.
	sidecars.Stop()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] != "host.trace.sidecar.restart-reset" {
			continue
		}
		fields := event["fields"].(map[string]any)
		if fields["sidecar"] != support.EchoSidecar || fields["surface"] != "s2" {
			t.Fatalf("restart-reset fields = %v", fields)
		}
		found = true
	}
	if !found {
		t.Fatal("the opened surface recorded no host.trace.sidecar.restart-reset")
	}
}

// contract: sidecars.restart.refuses-already-open-surface
func TestRestartRefusesAnAlreadyOpenSurface(t *testing.T) {
	sidecars, _, clock := restartSidecars(t)
	// s3 is open: its request failed the first process, which is not the process that stopped.
	first, second := support.NewFakeOwner("/projects/b"), support.NewFakeOwner("/projects/a")
	if err := sendAt(t, clock, sidecars, first, "s3", 0); err != nil {
		t.Fatal(err)
	}
	requireInvalidFailure3(t, first, "s3", 0)
	for _, offset := range []time.Duration{10 * time.Second, 20 * time.Second, 30 * time.Second} {
		if err := sendAt(t, clock, sidecars, second, "s1", offset); err != nil {
			t.Fatalf("send at %v: %v", offset, err)
		}
		requireInvalidFailure3(t, second, "s1", offset)
	}
	// The fourth failure stopped the sidecar. s3 is open, so its next request is refused too.
	err := sendAt(t, clock, sidecars, first, "s3", 40*time.Second)
	if err == nil || err.Error() != "sidecar "+support.EchoSidecar+": restart limit" {
		t.Fatalf("send of the open surface s3 after the stop = %v, want the restart limit refusal", err)
	}
	if failure := first.Failure(t); failure.Surface != "s3" || failure.Reason != "restart limit" {
		t.Fatalf("refused failure = %+v", failure)
	}
}

// requireInvalidFailure3 waits for the next failure of owner and checks that the surface failed with an invalid message.
func requireInvalidFailure3(t *testing.T, owner *support.FakeOwner, surface string, offset time.Duration) {
	t.Helper()
	if failure := owner.Failure(t); failure.Sidecar != support.EchoSidecar || failure.Surface != surface || !strings.Contains(failure.Reason, "invalid message") {
		t.Fatalf("failure of %s at %v = %+v", surface, offset, failure)
	}
}
