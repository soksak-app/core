// The workbench calls the host handlers through one table, on a goroutine for each call, and receives each answer in a later step
// (docs/spec/hosts.md#workbench).
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// steps is the main thread of a test: a queue of tasks that runs one at a time.
type steps chan func()

func (s steps) post(task func()) { s <- task }

// run runs the next step.
func (s steps) run() { (<-s)() }

// drain runs the later steps until nothing can post another one: no step waits and no goroutine of the workbench works. A host
// call that still runs holds it however long it takes, and one that waits at a gate of the test does not. A timer is not waited
// for; a test that needs one runs until its state arrives. drain judges once at each event that can end it, a step or the end
// or the gate of a goroutine (activity), and judges no time: a goroutine that keeps working holds it, and the limit of the test
// runner reports that test.
func (s steps) drain(t testing.TB) {
	t.Helper()
	for {
		if task, queued := s.queued(); queued {
			task()
			continue
		}
		if activity.running() == 0 {
			// Every goroutine posted its step before it ended or stopped at a gate, so a step that is not here now never comes.
			task, queued := s.queued()
			if !queued {
				return
			}
			task()
			continue
		}
		s.next()
	}
}

// next runs the next step, or returns at the next change of the goroutines of the workbench, whichever comes first.
func (s steps) next() {
	select {
	case task := <-s:
		task()
	case <-activity.changed:
	}
}

// queued returns the step that waits, if one does, without waiting for one.
func (s steps) queued() (func(), bool) {
	select {
	case task := <-s:
		return task, true
	default:
		return nil, false
	}
}

// activity counts the goroutines of the workbench that work: the workbench counts each goroutine that it starts until its end
// (workbench.Running), and a gate of the test takes a goroutine out of the count while it waits there. Each change of the count,
// and each state that a test fixture sets on such a goroutine without a step (wake), is a change that until and drain judge.
var activity = newActivity()

type activityCount struct {
	mu      sync.Mutex
	working int
	changed chan struct{}
}

func newActivity() *activityCount {
	a := &activityCount{changed: make(chan struct{}, 1)}
	workbench.Running = a.add
	return a
}

func (a *activityCount) add(delta int) {
	a.mu.Lock()
	a.working += delta
	a.mu.Unlock()
	a.wake()
}

func (a *activityCount) running() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.working
}

// wake tells until and drain that a state changed. A change that nobody waits for yet stays until the next wait.
func (a *activityCount) wake() {
	select {
	case a.changed <- struct{}{}:
	default:
	}
}

// gate holds the goroutines of host calls that wait for the test until it opens. A goroutine that waits at the gate does not
// work, so drain does not wait for it; open counts each waiting goroutine as working again before it lets it go, so no drain
// ends between the opening and the work that follows it. A gate opens once, and an open after that does nothing.
type gate struct {
	mu      sync.Mutex
	waiting int
	opened  bool
	ch      chan struct{}
}

func newGate() *gate { return &gate{ch: make(chan struct{})} }

// wait holds the goroutine until the gate opens.
func (g *gate) wait() {
	g.mu.Lock()
	if g.opened {
		g.mu.Unlock()
		return
	}
	g.waiting++
	g.mu.Unlock()
	activity.add(-1)
	<-g.ch
}

// open lets every goroutine that waits at the gate go on, and every later wait passes.
func (g *gate) open() {
	g.mu.Lock()
	if g.opened {
		g.mu.Unlock()
		return
	}
	g.opened = true
	waiting := g.waiting
	g.waiting = 0
	g.mu.Unlock()
	activity.add(waiting)
	close(g.ch)
}

// mailbox carries values from a goroutine of the test or of a host call to a host call that waits for them. A host call that waits
// for a value does not work; put counts it as working again before it hands the value over.
type mailbox[T any] struct {
	mu      sync.Mutex
	values  []T
	waiting int
	ch      chan T
}

func newMailbox[T any]() *mailbox[T] { return &mailbox[T]{ch: make(chan T)} }

// take returns the next value, and holds the goroutine until one is put.
func (m *mailbox[T]) take() T {
	m.mu.Lock()
	if len(m.values) > 0 {
		value := m.values[0]
		m.values = m.values[1:]
		m.mu.Unlock()
		return value
	}
	m.waiting++
	m.mu.Unlock()
	activity.add(-1)
	return <-m.ch
}

// put hands value to a goroutine that waits for one, or keeps it for the next take.
func (m *mailbox[T]) put(value T) {
	m.mu.Lock()
	if m.waiting == 0 {
		m.values = append(m.values, value)
		m.mu.Unlock()
		return
	}
	m.waiting--
	m.mu.Unlock()
	activity.add(1)
	m.ch <- value
}

func TestPresentSurfacesFromAStepAnswersInALaterStep(t *testing.T) {
	queue := make(steps, 8)
	// The handler waits for work that runs in a later step, as PresentSurfaces waits for the worker of the main thread.
	work := newGate()
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"presentSurfaces": func(_ context.Context, argument json.RawMessage) (any, error) {
			work.wait()
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
	queue.post(work.open)
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
	first, entered := newGate(), make(chan string, 2)
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"sidecarSend": func(_ context.Context, argument json.RawMessage) (any, error) {
			entered <- string(argument)
			if string(argument) == `"first"` {
				first.wait()
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
	first.open()
	queue.run()
	if got := <-entered; got != `"second"` {
		t.Fatalf("the second call is %s", got)
	}
	queue.run()
}

// A host call that still runs holds drain, however late its answer comes: a later step of it is part of the steps. The handler
// tells that it started and waits at a gate; the test opens the gate, so the handler works on while drain runs.
func TestDrainWaitsForAHostCallThatRuns(t *testing.T) {
	queue := make(steps, 8)
	started, proceed := make(chan struct{}, 1), newGate()
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"slow": func(context.Context, json.RawMessage) (any, error) {
			started <- struct{}{}
			proceed.wait()
			return "done", nil
		},
	}, queue.post)
	var answer any
	calls.Call("slow", nil, func(value any, _ error) { answer = value })
	<-started
	proceed.open()
	queue.drain(t)
	if answer != "done" {
		t.Fatalf("drain ended with the answer %v", answer)
	}
}

// A host call that waits for the test does not hold drain: only the test can end the wait.
func TestDrainEndsWhileAHostCallWaitsForTheTest(t *testing.T) {
	queue := make(steps, 8)
	release := newGate()
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"held": func(context.Context, json.RawMessage) (any, error) {
			release.wait()
			return "done", nil
		},
	}, queue.post)
	var answer any
	calls.Call("held", nil, func(value any, _ error) { answer = value })
	queue.drain(t)
	if answer != nil {
		t.Fatalf("the answer %v came before the release", answer)
	}
	release.open()
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

// The calls of a workbench that ended give no answer of a call that ran across the end, and a later call, also one that waits for
// its order, reaches no handler.
func TestEndedCallsAnswerNothingAndCallNothing(t *testing.T) {
	queue := make(steps, 8)
	release := newGate()
	entered := make(chan string, 4)
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"presentSurfaces": func(context.Context, json.RawMessage) (any, error) {
			entered <- "presentSurfaces"
			release.wait()
			return nil, errors.New("surface preparation 9 is no longer current")
		},
		"exposureChanged": func(context.Context, json.RawMessage) (any, error) {
			entered <- "exposureChanged"
			return nil, nil
		},
	}, queue.post)
	var answers []string
	calls.CallInOrder("surfaces", "presentSurfaces", nil, func(any, error) { answers = append(answers, "presentSurfaces") })
	calls.CallInOrder("surfaces", "exposureChanged", nil, func(any, error) { answers = append(answers, "exposureChanged") })
	queue.drain(t)
	calls.End()
	release.open()
	queue.drain(t)
	calls.Call("exposureChanged", nil, func(any, error) { answers = append(answers, "exposureChanged") })
	queue.drain(t)
	close(entered)
	var reached []string
	for name := range entered {
		reached = append(reached, name)
	}
	if strings.Join(reached, " ") != "presentSurfaces" || len(answers) != 0 {
		t.Fatalf("the ended calls reached %v and answered %v", reached, answers)
	}
}
