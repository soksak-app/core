package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
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
}

// NewRequests returns the requests of a window. post runs a task as a later step of the main thread, and failed receives the line of
// a request that cannot be read and of a reply that the host refuses.
func NewRequests(registry *Registry, calls *Calls, post func(task func()), failed func(line string)) *Requests {
	return &Requests{registry: registry, calls: calls, post: post, failed: failed}
}

// Deliver receives the values of the event exposure-request.
func (q *Requests) Deliver(data ...any) {
	q.post(func() {
		request, err := readRequest(data)
		if err != nil {
			q.failed(fmt.Sprintf("exposure request: %v", err))
			return
		}
		q.registry.Reply(request.Method, request.Params, q.changed, func(result any, err error) {
			q.send("exposureReply", "exposure reply", replyOf(request.ID, result, err))
		})
	})
}

// Reply answers the request id, for a request that a view runs.
func (q *Requests) Reply(id uint64, result any, err error) {
	q.send("exposureReply", "exposure reply", replyOf(id, result, err))
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

// send makes a host call of the answers and reports its failure under where.
func (q *Requests) send(call, where string, argument any) {
	q.calls.CallInOrder(exposureOrder, call, argument, func(_ any, err error) {
		if err != nil {
			q.failed(fmt.Sprintf("%s: %v", where, err))
		}
	})
}
