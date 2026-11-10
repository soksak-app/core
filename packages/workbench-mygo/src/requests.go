package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
)

// exposureOrder is the order of the calls that answer the host: a watch sends its first value before its reply, and the values of a
// status arrive in the order of their changes.
const exposureOrder = "exposure"

// Requests answers the requests that the host sends to one window as the event exposure-request, which a main page answers on the
// other hosts (docs/spec/exposure.md#relay). A request runs in a step of the main thread, as the command of a pressed element does, and
// its answer returns through the host call exposureReply.
type Requests struct {
	registry *Registry
	calls    *Calls
	post     func(task func())
	failed   func(line string)
	// delivered is the number of the last delivered request, open holds the number of each delivered request whose reply the host
	// has not taken yet, and answered holds what waits for the replies of the requests up to a number (Answered).
	delivered int
	open      map[int]bool
	answered  []requestWait
}

// requestWait is a step that waits for the replies of the requests up to the number until.
type requestWait struct {
	until int
	then  func()
}

// NewRequests returns the requests of a window. post runs a task as a later step of the main thread, and failed receives the line of
// a request that cannot be read and of a reply that the host refuses.
func NewRequests(registry *Registry, calls *Calls, post func(task func()), failed func(line string)) *Requests {
	return &Requests{registry: registry, calls: calls, post: post, failed: failed, open: map[int]bool{}}
}

// Deliver receives the values of the event exposure-request.
func (q *Requests) Deliver(data ...any) {
	q.delivered++
	number := q.delivered
	q.open[number] = true
	q.post(func() {
		request, err := readRequest(data)
		if err != nil {
			q.failed(fmt.Sprintf("exposure request: %v", err))
			q.closed(number)
			return
		}
		q.registry.Reply(request.Method, request.Params, q.changed, func(result any, err error) {
			q.calls.CallInOrder(exposureOrder, "exposureReply", replyOf(request.ID, result, err), func(_ any, err error) {
				if err != nil {
					q.failed(fmt.Sprintf("exposure reply: %v", err))
				}
				q.closed(number)
			})
		})
	})
}

// Mark is the number of the last delivered request: a step decided now waits for the replies of the requests up to it (Answered).
func (q *Requests) Mark() int { return q.delivered }

// Answered runs then once the host has taken the reply of every request delivered up to the number mark, at once when none of them is
// open. A new start of the workbench ends the document that the host waits on, so it runs here and a reply is not lost to it; a
// request delivered after the mark does not delay it, because the end of the workbench ends that request
// (docs/spec/installation.md#applying-a-change).
func (q *Requests) Answered(mark int, then func()) {
	q.answered = append(q.answered, requestWait{until: mark, then: then})
	q.endWaits()
}

// closed ends the request number whose reply the host took, and runs what waits for it.
func (q *Requests) closed(number int) {
	delete(q.open, number)
	q.endWaits()
}

// endWaits runs each wait whose requests are no longer open, in the order of the waits.
func (q *Requests) endWaits() {
	oldest := math.MaxInt
	for number := range q.open {
		oldest = min(oldest, number)
	}
	ended := 0
	for ended < len(q.answered) && q.answered[ended].until < oldest {
		ended++
	}
	waits := slices.Clone(q.answered[:ended])
	q.answered = q.answered[ended:]
	for _, wait := range waits {
		wait.then()
	}
}

// ReplyFor answers the request id that the host forwarded to surface.
func (q *Requests) ReplyFor(surface string, id uint64, result any, err error) {
	reply := replyOf(id, result, err)
	reply["surface"] = surface
	q.send("exposureReply", "exposure reply", reply)
}

// exposureRequest is the value of the event exposure-request.
type exposureRequest struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func readRequest(data []any) (request exposureRequest, err error) {
	if len(data) != 1 {
		return request, fmt.Errorf("the event carries %d values, want one", len(data))
	}
	encoded, err := json.Marshal(data[0])
	if err != nil {
		return request, err
	}
	return request, json.Unmarshal(encoded, &request)
}

// replyOf is the reply {id, result} or {id, error: {code, message}}. A result that is not JSON is a failure of the request, which
// still reaches the host, because a command request waits for its reply without a limit.
func replyOf(id uint64, result any, failure error) map[string]any {
	if failure == nil {
		encoded, err := json.Marshal(result)
		if err == nil {
			return map[string]any{"id": id, "result": json.RawMessage(encoded)}
		}
		failure = err
	}
	var refusal *Refusal
	if !errors.As(failure, &refusal) {
		refusal = Refuse(Failed, "%s", failure.Error())
	}
	return map[string]any{"id": id, "error": refusal}
}

// changed sends the value of a watched status to the host.
func (q *Requests) changed(name string, value any) {
	q.send("exposureChanged", "exposure change", map[string]any{"name": name, "value": value})
}

// surfaceChanged sends the value of a watched status of a surface to the host. surface is the surface that the watch names.
func (q *Requests) surfaceChanged(name string, surface *string, value any) {
	change := map[string]any{"name": name, "value": value}
	if surface != nil {
		change["surface"] = *surface
	}
	q.send("exposureChanged", "exposure change", change)
}

// send makes a host call of the answers and reports its failure under where.
func (q *Requests) send(call, where string, argument any) {
	q.calls.CallInOrder(exposureOrder, call, argument, func(_ any, err error) {
		if err != nil {
			q.failed(fmt.Sprintf("%s: %v", where, err))
		}
	})
}
