// The workbench calls the host handlers through one table, on a goroutine for each call, and receives each answer in a later step
// (docs/spec/hosts.md#workbench).
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// steps is the main thread of a test: a queue of tasks that runs one at a time.
type steps chan func()

func (s steps) post(task func()) { s <- task }

// run runs the next step.
func (s steps) run() { (<-s)() }

// drain runs the later steps until nothing can post another one: no step waits and every other goroutine waits for
// something only a goroutine or the test can end. A host call that still runs holds it however long it takes, and one
// that waits for the test does not. A timer is not waited for; a test that needs one runs until its state arrives.
func (s steps) drain(t testing.TB) {
	t.Helper()
	limit := time.NewTimer(drainLimit)
	defer limit.Stop()
	for {
		select {
		case task := <-s:
			task()
			limit.Reset(drainLimit)
			continue
		default:
		}
		working := workingGoroutine()
		if working == "" {
			// The goroutines waited after every step that they posted, so a step that is not here now never comes.
			select {
			case task := <-s:
				task()
				limit.Reset(drainLimit)
				continue
			default:
				return
			}
		}
		select {
		case task := <-s:
			task()
			limit.Reset(drainLimit)
		case <-time.After(100 * time.Microsecond):
		case <-limit.C:
			t.Fatalf("a goroutine works without a step for %v:\n%s", drainLimit, working)
		}
	}
}

// drainLimit is the time without a step after which a goroutine that keeps working is a defect of the test.
const drainLimit = 60 * time.Second

// waitingStates are the states of a goroutine that only another goroutine can end, as runtime.Stack prints them.
var waitingStates = []string{"chan receive", "chan send", "select", "sync.Cond.Wait", "sync.WaitGroup.Wait", "IO wait", "finalizer wait"}

// workingGoroutine returns the stack of a goroutine other than the caller that is not waiting, or "" when there is none.
func workingGoroutine() string {
	buffer := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buffer, true)
		if n < len(buffer) {
			buffer = buffer[:n]
			break
		}
		buffer = make([]byte, 2*len(buffer))
	}
	// The stack of the caller comes first.
	for _, stack := range strings.Split(string(buffer), "\n\n")[1:] {
		_, rest, found := strings.Cut(stack, "[")
		if !found {
			continue
		}
		state, _, _ := strings.Cut(rest, "]")
		state, _, _ = strings.Cut(state, ",")
		if slices.ContainsFunc(waitingStates, func(waiting string) bool { return strings.HasPrefix(state, waiting) }) {
			continue
		}
		return stack
	}
	return ""
}

func TestPresentSurfacesFromAStepAnswersInALaterStep(t *testing.T) {
	queue := make(steps, 8)
	// The handler waits for work that runs in a later step, as PresentSurfaces waits for the worker of the main thread.
	work := make(chan struct{})
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"presentSurfaces": func(_ context.Context, argument json.RawMessage) (any, error) {
			<-work
			return string(argument), nil
		},
	}, queue.post)
	var answer any
	queue.post(func() {
		calls.Call("presentSurfaces", map[string]any{"id": 1}, func(value any, err error) {
			if err != nil {
				t.Error(err)
			}
			answer = value
		})
	})
	queue.run()
	if answer != nil {
		t.Fatalf("the answer arrived in the step of the call: %v", answer)
	}
	queue.post(func() { close(work) })
	queue.run()
	queue.run()
	if answer != `{"id":1}` {
		t.Fatalf("the answer is %v", answer)
	}
}

func TestACallOfAnUnknownNameAnswersWithItsError(t *testing.T) {
	queue := make(steps, 8)
	calls := workbench.NewCalls(map[string]workbench.HostCall{}, queue.post)
	var failure error
	calls.Call("absent", nil, func(_ any, err error) { failure = err })
	queue.run()
	if failure == nil || failure.Error() != "unknown host call: absent" {
		t.Fatalf("the failure is %v", failure)
	}
}

func TestAHandlerErrorReachesTheAnswer(t *testing.T) {
	queue := make(steps, 8)
	failed := errors.New("refused")
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"log": func(context.Context, json.RawMessage) (any, error) { return nil, failed },
	}, queue.post)
	var failure error
	calls.Call("log", nil, func(_ any, err error) { failure = err })
	queue.run()
	if !errors.Is(failure, failed) {
		t.Fatalf("the failure is %v", failure)
	}
}

func TestCallsOfOneOrderRunOneAfterTheOther(t *testing.T) {
	queue := make(steps, 8)
	first, entered := make(chan struct{}), make(chan string, 2)
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"sidecarSend": func(_ context.Context, argument json.RawMessage) (any, error) {
			entered <- string(argument)
			if string(argument) == `"first"` {
				<-first
			}
			return nil, nil
		},
	}, queue.post)
	calls.CallInOrder("sidecar", "sidecarSend", "first", func(any, error) {})
	calls.CallInOrder("sidecar", "sidecarSend", "second", func(any, error) {})
	if got := <-entered; got != `"first"` {
		t.Fatalf("the first call is %s", got)
	}
	select {
	case got := <-entered:
		t.Fatalf("%s started before the first call finished", got)
	default:
	}
	close(first)
	queue.run()
	if got := <-entered; got != `"second"` {
		t.Fatalf("the second call is %s", got)
	}
	queue.run()
}

// A host call that still runs holds drain, however late its answer comes: a later step of it is part of the steps.
func TestDrainWaitsForAHostCallThatRuns(t *testing.T) {
	queue := make(steps, 8)
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"slow": func(context.Context, json.RawMessage) (any, error) {
			time.Sleep(50 * time.Millisecond)
			return "done", nil
		},
	}, queue.post)
	var answer any
	calls.Call("slow", nil, func(value any, _ error) { answer = value })
	queue.drain(t)
	if answer != "done" {
		t.Fatalf("drain ended with the answer %v", answer)
	}
}

// A host call that waits for the test does not hold drain: only the test can end the wait.
func TestDrainEndsWhileAHostCallWaitsForTheTest(t *testing.T) {
	queue := make(steps, 8)
	release := make(chan struct{})
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"held": func(context.Context, json.RawMessage) (any, error) {
			<-release
			return "done", nil
		},
	}, queue.post)
	var answer any
	calls.Call("held", nil, func(value any, _ error) { answer = value })
	queue.drain(t)
	if answer != nil {
		t.Fatalf("the answer %v came before the release", answer)
	}
	close(release)
	queue.drain(t)
	if answer != "done" {
		t.Fatalf("drain ended with the answer %v", answer)
	}
}

// A call in a step of an answer is drained like the first: each answer can start the next call.
func TestDrainFollowsTheCallsOfAnAnswer(t *testing.T) {
	queue := make(steps, 8)
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"next": func(context.Context, json.RawMessage) (any, error) {
			time.Sleep(20 * time.Millisecond)
			return nil, nil
		},
	}, queue.post)
	answers := 0
	var again func(any, error)
	again = func(any, error) {
		answers++
		if answers < 3 {
			calls.Call("next", nil, again)
		}
	}
	calls.Call("next", nil, again)
	queue.drain(t)
	if answers != 3 {
		t.Fatalf("drain ended after %d answers", answers)
	}
}
