package windows

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// uiPostRetry is the wait before a delayed task enters the queue again after the queue refused it.
const uiPostRetry = 50 * time.Millisecond

// uiQueue holds the tasks of the UI thread. It holds no system call, so it also runs where Windows does not exist.
type uiQueue struct {
	mu    sync.Mutex
	tasks []func()
	// wake asks the UI thread to call run later. It is nil until the UI thread starts, and it must not run a task itself.
	wake func() error
	// after calls fire once after a wait, on any goroutine.
	after func(wait time.Duration, fire func())
	// report receives the failure of a delayed task, which has no caller to answer.
	report func(err error)
}

// add queues task as a later step of the UI thread. A task that add refuses never runs.
func (q *uiQueue) add(task func()) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.wake == nil {
		return errors.New("the UI thread has not started")
	}
	q.tasks = append(q.tasks, task)
	if err := q.wake(); err != nil {
		q.tasks = q.tasks[:len(q.tasks)-1]
		return fmt.Errorf("UI task message: %w", err)
	}
	return nil
}

// addAfter queues task after delay. A refusal of the queue at that time is reported and the task enters it later, because the delay already
// promised that it runs.
func (q *uiQueue) addAfter(delay time.Duration, task func()) error {
	if delay < 0 {
		return fmt.Errorf("UI queue delay %s is negative", delay)
	}
	q.mu.Lock()
	started := q.wake != nil
	q.mu.Unlock()
	if !started {
		return errors.New("the UI thread has not started")
	}
	var fire func()
	fire = func() {
		if err := q.add(task); err != nil {
			q.report(err)
			q.after(uiPostRetry, fire)
		}
	}
	q.after(delay, fire)
	return nil
}

// run runs the tasks that were queued when it started, in order. A task that a task queues waits for a later run, so a step ends.
func (q *uiQueue) run() {
	q.mu.Lock()
	tasks := q.tasks
	q.tasks = nil
	q.mu.Unlock()
	for _, task := range tasks {
		task()
	}
}
