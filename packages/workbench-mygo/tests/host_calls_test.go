// The workbench calls the host handlers through one table, on a goroutine for each call, and receives each answer in a later step
// (docs/spec/hosts.md#workbench).
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// steps is the main thread of a test: a queue of tasks that runs one at a time.
type steps chan func()

func (s steps) post(task func()) { s <- task }

// run runs the next step.
func (s steps) run() { (<-s)() }

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
