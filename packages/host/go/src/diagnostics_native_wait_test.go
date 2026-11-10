//go:build diagnostics

package host

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// messageOf is the message of err without the code of an RPC error, or "" for no error.
func messageOf(err error) string {
	var rpc *RPCError
	switch {
	case err == nil:
		return ""
	case errors.As(err, &rpc):
		return rpc.Message
	}
	return err.Error()
}

// nativeWaitResult is the answer of a native wait of a test and the reason of its end.
type nativeWaitResult struct {
	exited bool
	reason string
}

// testNativeWait starts a native wait of window s on connection c whose library answers through the returned answer, and
// whose end answers false once. started closes when the wait started; result receives what awaitNative returned.
func testNativeWait(t *testing.T, s *Surfaces, c *endpointConn) (answer func(bool), started <-chan struct{}, result <-chan nativeWaitResult) {
	t.Helper()
	previous := framework
	framework = stepFramework{}
	t.Cleanup(func() { framework = previous })
	var mu sync.Mutex
	var done func(bool)
	answerOnce := func(exited bool) {
		mu.Lock()
		d := done
		done = nil
		mu.Unlock()
		if d != nil {
			d(exited)
		}
	}
	begun := make(chan struct{})
	results := make(chan nativeWaitResult, 1)
	go func() {
		exited, reason := awaitNative(s, c, func(answer func(bool)) func(string) {
			mu.Lock()
			done = answer
			mu.Unlock()
			close(begun)
			return func(string) { answerOnce(false) }
		})
		results <- nativeWaitResult{exited, reason}
	}()
	return answerOnce, begun, results
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
func TestANativeWaitEndsByItsAnswerWithoutAnEnd(t *testing.T) {
	s := &Surfaces{name: "native-wait-answer"}
	c := endpointConnection(t)
	answer, started, result := testNativeWait(t, s, c)
	<-started
	answer(true)
	if got := <-result; got != (nativeWaitResult{exited: true}) {
		t.Fatalf("the answered wait returned %+v, want the answer without an end", got)
	}
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
func TestANativeWaitEndsWithTheConnectionOfItsRequest(t *testing.T) {
	s := &Surfaces{name: "native-wait-connection"}
	c := endpointConnection(t)
	_, started, result := testNativeWait(t, s, c)
	<-started
	c.close("the requester closed")
	if got := <-result; got != (nativeWaitResult{reason: waitEndConnection}) {
		t.Fatalf("the wait returned %+v at the close of its connection", got)
	}
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
func TestANativeWaitEndsWithItsWindowAndItsPage(t *testing.T) {
	for _, end := range []string{waitEndWindow, waitEndPage} {
		s := &Surfaces{name: "native-wait-" + end}
		_, started, result := testNativeWait(t, s, endpointConnection(t))
		<-started
		if end == waitEndWindow {
			if diagnosticWindowClosed == nil {
				t.Fatal("a diagnostic build does not end the waits of a window that closes")
			}
			diagnosticWindowClosed(s)
		} else {
			if diagnosticPageEnded == nil {
				t.Fatal("a diagnostic build does not end the waits of a window whose page ends")
			}
			diagnosticPageEnded(s)
		}
		if got := <-result; got != (nativeWaitResult{reason: end}) {
			t.Fatalf("the wait returned %+v when %s", got, end)
		}
	}
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
func TestANativeWaitOfAnotherWindowKeepsWaiting(t *testing.T) {
	s := &Surfaces{name: "native-wait-kept"}
	answer, started, result := testNativeWait(t, s, endpointConnection(t))
	<-started
	// An end that reached the wait would be taken before the answer, since the end is given before it returns.
	endNativeWaits(&Surfaces{name: "native-wait-other"}, waitEndWindow)
	answer(true)
	if got := <-result; got != (nativeWaitResult{exited: true}) {
		t.Fatalf("the wait returned %+v after the end of another window", got)
	}
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
func TestUnreachedWindowObjectsAnswerTheEndOfTheirWait(t *testing.T) {
	counts := platform.WindowObjects{WindowCompositions: 1, SurfaceHosts: 2, InputRegistrations: 3}
	if _, err := nativeObjectsAnswer(nil, counts, false, waitEndWindow); messageOf(err) != "the window object counts ended before the application handled an event: the window closed" {
		t.Fatalf("unreached counts without expected counts answered %v", err)
	}
	if _, err := nativeObjectsAnswer(nil, counts, true, ""); err != nil {
		t.Fatalf("reached counts answered %v", err)
	}
	expected := platform.WindowObjects{}
	want := fmt.Sprintf("window object counts did not reach %s before the endpoint connection of the request closed; they are %s", &expected, counts)
	if _, err := nativeObjectsAnswer(&expected, counts, false, waitEndConnection); messageOf(err) != want {
		t.Fatalf("unreached expected counts answered %v, want %s", err, want)
	}
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
func TestAProcessExitAnswerNamesTheEndOfItsWait(t *testing.T) {
	if _, err := processExitAnswer(7, true, ""); err != nil {
		t.Fatalf("an exit answered %v", err)
	}
	if _, err := processExitAnswer(7, false, waitEndPage); messageOf(err) != "process 7 did not exit before the page of the window ended" {
		t.Fatalf("an ended wait answered %v", err)
	}
	if _, err := processExitAnswer(7, false, ""); messageOf(err) != "process 7 exit wait could not be registered" {
		t.Fatalf("a wait that could not be registered answered %v", err)
	}
}

// captureEnds is a capture device whose operations wait until CaptureEndWait ends the wait of their token.
type captureEnds struct {
	platform.Capturer
	mu   sync.Mutex
	ends map[uint64]chan string
}

// ended receives the reason of the end of the wait of token.
func (f *captureEnds) ended(token uint64) chan string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ends == nil {
		f.ends = map[uint64]chan string{}
	}
	if f.ends[token] == nil {
		f.ends[token] = make(chan string, 1)
	}
	return f.ends[token]
}

func (f *captureEnds) CaptureEndWait(token uint64, reason string) { f.ended(token) <- reason }

// testCaptureWait starts an operation of device on window s and connection c that waits for the end of its token, and
// returns the reason that ended it on result once started closed.
func testCaptureWait(s *Surfaces, c *endpointConn, device *captureEnds) (started <-chan struct{}, result <-chan string) {
	begun := make(chan struct{})
	results := make(chan string, 1)
	go func() {
		results <- awaitCapture(platformCapture{Capturer: device, window: s, connection: c}, func(token uint64) string {
			close(begun)
			return <-device.ended(token)
		})
	}()
	return begun, results
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
func TestACaptureWaitEndsWithTheConnectionOfItsRequest(t *testing.T) {
	c := endpointConnection(t)
	started, result := testCaptureWait(&Surfaces{name: "capture-wait-connection"}, c, &captureEnds{})
	<-started
	c.close("the requester closed")
	if got := <-result; got != waitEndConnection {
		t.Fatalf("the capture wait ended with %q at the close of its connection", got)
	}
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
func TestACaptureWaitEndsWithItsWindowAndItsPage(t *testing.T) {
	for _, end := range []string{waitEndWindow, waitEndPage} {
		s := &Surfaces{name: "capture-wait-" + end}
		started, result := testCaptureWait(s, endpointConnection(t), &captureEnds{})
		<-started
		if end == waitEndWindow {
			diagnosticWindowClosed(s)
		} else {
			diagnosticPageEnded(s)
		}
		if got := <-result; got != end {
			t.Fatalf("the capture wait ended with %q when %s", got, end)
		}
	}
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
func TestAnAnsweredCaptureOperationTakesBackItsEnds(t *testing.T) {
	s := &Surfaces{name: "capture-wait-answered"}
	c := endpointConnection(t)
	device := &captureEnds{}
	var answered uint64
	if got := awaitCapture(platformCapture{Capturer: device, window: s, connection: c}, func(token uint64) string {
		answered = token
		return "answered"
	}); got != "answered" {
		t.Fatalf("the answered operation returned %q", got)
	}
	// The connection runs its ends in its close and the window runs them in endNativeWaits, so an end left behind is
	// already in the channel when they return.
	c.close("the requester closed")
	endNativeWaits(s, waitEndWindow)
	select {
	case reason := <-device.ended(answered):
		t.Fatalf("the operation that answered was ended with %q after it returned", reason)
	default:
	}
	var later uint64
	awaitCapture(platformCapture{Capturer: device}, func(token uint64) string { later = token; return "" })
	if later <= answered {
		t.Fatalf("the later operation has the token %d, not larger than the token %d before it", later, answered)
	}
}
