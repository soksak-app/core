//go:build diagnostics

package host

import (
	"encoding/json"
	"reflect"
	"testing"
)

// contract: view.call.reply
// The post of a reply that the document refuses fails the reply with its text and leaves the call open, so the end of the process settles
// it. The refusal is the fault point of the post to a view document (faultViewPost), which fails the post as the native post fails when
// the document refuses the message.
func TestViewReplyPostRefusalLeavesCallOpenForProcessEnd(t *testing.T) {
	p := echoViewProbe(t)
	p.ready(t)
	const id = uint64(995)
	if err := p.message(`{"message":{"sok":1,"id":995,"command":"probe.run","params":null}}`); err != nil {
		t.Fatalf("view call: %v", err)
	}
	t.Setenv(faultViewPost, "post")
	var replied error
	p.main(func() {
		replied = p.s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), ID: id, Result: json.RawMessage(`null`)})
	})
	if replied == nil || replied.Error() != "probe-surface: the view document refused the message" {
		t.Fatalf("refused view reply error: %v", replied)
	}
	if calls := p.openCalls(); !reflect.DeepEqual(calls, []openViewCall{{plugin: "probe", command: "probe.run", id: id}}) {
		t.Fatalf("open calls after refused post: %+v, want the unanswered view call", calls)
	}
}

// contract: view.call.reply
func TestViewReplyPostRefusalReturnsErrorWithoutPostedRecord(t *testing.T) {
	isolateTraceRecords(t)
	p := echoViewProbe(t)
	p.s.name = "main"
	p.ready(t)
	t.Setenv(faultViewPost, "post")
	const id = uint64(993)
	var replied error
	p.main(func() {
		replied = p.s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), ID: id, Result: json.RawMessage(`null`)})
	})
	if replied == nil || replied.Error() != "probe-surface: the view document refused the message" {
		t.Fatalf("refused post error: %v", replied)
	}
	if hasViewReplyDispatch(t, id, nil) {
		t.Fatalf("refused native post emitted a dispatch record")
	}
}
