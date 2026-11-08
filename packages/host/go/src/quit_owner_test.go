package host

import (
	"errors"
	"testing"
)

// A quit that the system requests during the native work of an endpoint request runs after the response of that request, and
// once; outside such work, or for a request without a response, it runs at once.
// contract: endpoint.response.quit-follows-the-response
func TestQuitDuringOwnedNativeWorkFollowsTheResponse(t *testing.T) {
	scope, answer := newReplyScope()
	quits := 0
	failed := errors.New("the item failed")
	err := WithResponseOwner(scope, func() error {
		AfterOwnerResponse(func() { quits++ })
		if quits != 0 {
			t.Fatal("the quit ran inside the native work, before the response")
		}
		return failed
	})
	if !errors.Is(err, failed) {
		t.Fatalf("the native work returned %v, want its own error", err)
	}
	if quits != 0 {
		t.Fatal("the quit ran after the native work, before the response")
	}
	answer.finish(ReplyOutcome{Kind: ReplyWritten})
	answer.finish(ReplyOutcome{Kind: ReplyWritten})
	if quits != 1 {
		t.Fatalf("the quit ran %d times after the response, want 1", quits)
	}

	AfterOwnerResponse(func() { quits++ })
	if quits != 2 {
		t.Fatal("a quit without owned native work did not run at once")
	}
	if err := WithResponseOwner(nil, func() error { AfterOwnerResponse(func() { quits++ }); return nil }); err != nil {
		t.Fatal(err)
	}
	if quits != 3 {
		t.Fatal("a quit in the native work of a request without a response did not run at once")
	}
}
