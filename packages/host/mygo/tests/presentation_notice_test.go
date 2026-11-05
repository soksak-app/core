package adapter_test

// Checks the answers of the presentation notice with scripted notices, because a display gives no frame that finds no drawable on
// request (docs/spec/hosts.md#mygo-host).

import (
	"errors"
	"testing"

	"github.com/egoist/mygo"

	adapter "github.com/soksak-app/core/packages/host/mygo/src"
)

// answer is a notice of a frame.
type answer struct {
	presentation mygo.Presentation
	failure      error
}

// noticeOf answers each ask with the next answer and counts the asks.
func noticeOf(answers ...answer) (func(func(mygo.Presentation, error)) error, *int) {
	asked := new(int)
	return func(notice func(mygo.Presentation, error)) error {
		next := answers[*asked]
		*asked++
		notice(next.presentation, next.failure)
		return nil
	}, asked
}

// doneOf records each call of done.
func doneOf() (func(error), *[]error) {
	calls := new([]error)
	return func(err error) { *calls = append(*calls, err) }, calls
}

// contract: mygo.presentation.notice-answers
func TestAFrameThatFoundNoDrawableAsksAgainAndCallsBackOnItsNotice(t *testing.T) {
	notice, asked := noticeOf(answer{presentation: mygo.PresentNoDrawable}, answer{presentation: mygo.PresentNoDrawable}, answer{presentation: mygo.Presented})
	done, calls := doneOf()
	if err := adapter.AwaitPresentation("main", notice, nil, done); err != nil {
		t.Fatal(err)
	}
	if *asked != 3 {
		t.Fatalf("asked %d times, want 3", *asked)
	}
	if len(*calls) != 1 || (*calls)[0] != nil {
		t.Fatalf("done ran with %v, want one nil", *calls)
	}
}

// contract: mygo.presentation.notice-answers
func TestAFrameWithoutDamageCountsAsPresented(t *testing.T) {
	notice, _ := noticeOf(answer{presentation: mygo.PresentNoDamage})
	done, calls := doneOf()
	if err := adapter.AwaitPresentation("main", notice, nil, done); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0] != nil {
		t.Fatalf("done ran with %v, want one nil", *calls)
	}
}

// contract: mygo.presentation.notice-answers
func TestAHeldFrameFailsWhenItsCallerDoesNotWait(t *testing.T) {
	notice, _ := noticeOf(answer{presentation: mygo.PresentHeld})
	done, calls := doneOf()
	if err := adapter.AwaitPresentation("main", notice, nil, done); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0] == nil {
		t.Fatalf("done ran with %v, want one error", *calls)
	}
}

// contract: mygo.presentation.notice-answers
func TestAHeldFrameAsksAgainAfterTheRelease(t *testing.T) {
	notice, asked := noticeOf(answer{presentation: mygo.PresentHeld}, answer{presentation: mygo.Presented})
	done, calls := doneOf()
	var release func()
	if err := adapter.AwaitPresentation("main", notice, func(again func()) { release = again }, done); err != nil {
		t.Fatal(err)
	}
	if *asked != 1 || len(*calls) != 0 {
		t.Fatalf("before the release: asked %d times, done ran with %v", *asked, *calls)
	}
	release()
	if *asked != 2 || len(*calls) != 1 || (*calls)[0] != nil {
		t.Fatalf("after the release: asked %d times, done ran with %v", *asked, *calls)
	}
}

// contract: mygo.presentation.notice-answers
func TestAFailedFrameReturnsItsFailure(t *testing.T) {
	failure := errors.New("the device is lost")
	notice, _ := noticeOf(answer{presentation: mygo.PresentFailed, failure: failure})
	done, calls := doneOf()
	if err := adapter.AwaitPresentation("main", notice, nil, done); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || !errors.Is((*calls)[0], failure) {
		t.Fatalf("done ran with %v, want the failure", *calls)
	}
}

// contract: mygo.presentation.notice-answers
func TestAClosedWindowEndsTheWait(t *testing.T) {
	notice, _ := noticeOf(answer{presentation: mygo.PresentClosed})
	done, calls := doneOf()
	if err := adapter.AwaitPresentation("main", notice, func(func()) {}, done); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0] == nil {
		t.Fatalf("done ran with %v, want one error", *calls)
	}
}

// contract: mygo.presentation.notice-answers
func TestAnAskThatFailsAfterANoticeReachesDone(t *testing.T) {
	refused := errors.New("the window is closed")
	asked := 0
	notice := func(answerIt func(mygo.Presentation, error)) error {
		asked++
		if asked == 2 {
			return refused
		}
		answerIt(mygo.PresentNoDrawable, nil)
		return nil
	}
	done, calls := doneOf()
	if err := adapter.AwaitPresentation("main", notice, nil, done); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || !errors.Is((*calls)[0], refused) {
		t.Fatalf("done ran with %v, want the refusal", *calls)
	}
}
