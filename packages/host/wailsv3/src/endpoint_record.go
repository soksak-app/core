package host

// The record of the endpoint methods (docs/spec/logging.md#entrances): every method that a client of the endpoint calls is
// the event `host.endpoint.call`, whether or not the performance trace is on.

import (
	"time"
)

// recordEndpointCall stores the event of one request: the method name, the arguments cut to CallTextBytes before they are
// copied, the result and the error text cut the same way, and the microseconds since started. A failed request is at the level
// `warn`.
func recordEndpointCall(req request, started time.Time, err error) {
	micros := time.Since(started).Microseconds()
	// A request without params has the arguments `null`, as one whose params are null.
	args, truncated := "null", false
	if len(req.Params) > 0 {
		args, truncated = cutText(req.Params, CallTextBytes)
	}
	if err == nil {
		EmitHost(LevelDebug, "host.endpoint.call", map[string]any{
			"name": methodOf(req), "args": args, "micros": micros, "ok": true, "truncated": truncated,
		})
		return
	}
	// The text is the code and the message that the client receives.
	text, cut := cutText(resultError(err), CallTextBytes)
	EmitHost(LevelWarn, "host.endpoint.call", map[string]any{
		"name": methodOf(req), "args": args, "micros": micros, "ok": false, "truncated": truncated || cut, "error": text,
	})
}
