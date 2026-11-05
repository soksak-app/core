package windows

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fakeTimer struct {
	wait time.Duration
	fire func()
}

// queuedUI is a queue whose wakes succeed until a test sets refuse, and whose waits end when the test fires them.
func queuedUI() (q *uiQueue, timers *[]fakeTimer, refuse *error, reported *[]error) {
	timers, refuse, reported = &[]fakeTimer{}, new(error), &[]error{}
	q = &uiQueue{
		wake:   func() error { return *refuse },
		after:  func(wait time.Duration, fire func()) { *timers = append(*timers, fakeTimer{wait, fire}) },
		report: func(err error) { *reported = append(*reported, err) },
	}
	return q, timers, refuse, reported
}

// contract: platform.windows.ui-queue.tasks-run-in-order-once
func TestUITasksRunInTheirOrderOnce(t *testing.T) {
	q, _, _, _ := queuedUI()
	var ran []string
	for _, name := range []string{"a", "b", "c"} {
		if err := q.add(func() { ran = append(ran, name) }); err != nil {
			t.Fatal(err)
		}
	}
	if len(ran) != 0 {
		t.Fatalf("ran %v before the step", ran)
	}
	q.run()
	q.run()
	if want := []string{"a", "b", "c"}; !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v, want %v", ran, want)
	}
}

// contract: platform.windows.ui-queue.task-queued-by-task-waits-for-later-step
func TestAUITaskThatATaskQueuesWaitsForALaterStep(t *testing.T) {
	q, _, _, _ := queuedUI()
	var ran []string
	if err := q.add(func() {
		ran = append(ran, "first")
		if err := q.add(func() { ran = append(ran, "second") }); err != nil {
			t.Error(err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	q.run()
	if want := []string{"first"}; !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v, want %v", ran, want)
	}
	q.run()
	if want := []string{"first", "second"}; !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v, want %v", ran, want)
	}
}

// contract: platform.windows.ui-queue.refused-task-never-runs
func TestAUITaskThatTheQueueRefusesNeverRuns(t *testing.T) {
	q, _, refuse, _ := queuedUI()
	*refuse = errors.New("full")
	ran := false
	err := q.add(func() { ran = true })
	if err == nil || !strings.Contains(err.Error(), "full") {
		t.Fatalf("error %v", err)
	}
	*refuse = nil
	q.run()
	if ran {
		t.Fatal("a refused task ran")
	}
}

// contract: platform.windows.ui-queue.refuses-before-its-thread
func TestAUIQueueBeforeItsThreadRefusesATask(t *testing.T) {
	q := &uiQueue{}
	if err := q.add(func() {}); err == nil {
		t.Fatal("add succeeded")
	}
	if err := q.addAfter(time.Second, func() {}); err == nil {
		t.Fatal("addAfter succeeded")
	}
}

// contract: platform.windows.ui-queue.delayed-task-runs-as-step-after-wait
func TestADelayedUITaskRunsAsAStepAfterItsWait(t *testing.T) {
	q, timers, _, _ := queuedUI()
	ran := false
	if err := q.addAfter(time.Second, func() { ran = true }); err != nil {
		t.Fatal(err)
	}
	if len(*timers) != 1 || (*timers)[0].wait != time.Second {
		t.Fatalf("timers %v", *timers)
	}
	q.run()
	if ran {
		t.Fatal("the task ran before its wait")
	}
	(*timers)[0].fire()
	if ran {
		t.Fatal("the task ran outside a step")
	}
	q.run()
	if !ran {
		t.Fatal("the task did not run")
	}
}

// contract: platform.windows.ui-queue.negative-delay-is-refused
func TestANegativeDelayIsRefused(t *testing.T) {
	q, timers, _, _ := queuedUI()
	if err := q.addAfter(-time.Second, func() {}); err == nil {
		t.Fatal("addAfter succeeded")
	}
	if len(*timers) != 0 {
		t.Fatalf("timers %v", *timers)
	}
}

// contract: platform.windows.ui-queue.refused-delayed-task-enters-later
func TestADelayedUITaskThatTheQueueRefusesEntersLater(t *testing.T) {
	q, timers, refuse, reported := queuedUI()
	ran := 0
	if err := q.addAfter(time.Second, func() { ran++ }); err != nil {
		t.Fatal(err)
	}
	*refuse = errors.New("full")
	(*timers)[0].fire()
	if len(*reported) != 1 {
		t.Fatalf("reported %v", *reported)
	}
	if len(*timers) != 2 || (*timers)[1].wait != uiPostRetry {
		t.Fatalf("timers %v", *timers)
	}
	*refuse = nil
	(*timers)[1].fire()
	q.run()
	if ran != 1 {
		t.Fatalf("ran %d times", ran)
	}
}
