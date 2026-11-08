package host

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"testing"
	"testing/synctest"
)

func responseTestConnection(conn net.Conn) *endpointConn {
	return &endpointConn{conn: conn, out: make(chan endpointFrame, 4), done: make(chan struct{})}
}

// A normal quit intent belongs after the actual transport write, never queue admission.
// contract: endpoint.response.follows-the-socket-write
func TestEndpointAfterResponseWaitsForActualSocketWrite(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		local, peer := net.Pipe()
		defer peer.Close()
		c := responseTestConnection(local)
		defer c.close("test ended")
		go c.write()
		scope, answer := newReplyScope()
		var outcomes []ReplyOutcome
		quit := false
		scope.AfterResponse(func(outcome ReplyOutcome) { outcomes = append(outcomes, outcome); quit = true })
		(&Endpoint{}).replyWithCompletion(c, request{ID: json.RawMessage("7")}, nil, nil, answer)
		synctest.Wait()
		if quit {
			t.Fatal("normal quit ran while the actual reply writer was blocked")
		}
		var prefix [4]byte
		if _, err := io.ReadFull(peer, prefix[:]); err != nil {
			t.Fatal(err)
		}
		body := make([]byte, binary.BigEndian.Uint32(prefix[:]))
		if _, err := io.ReadFull(peer, body); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		if !quit || len(outcomes) != 1 || outcomes[0].Kind != ReplyWritten {
			t.Fatalf("actual write completion: %v, quit=%v", outcomes, quit)
		}
		if string(body) != `{"id":7,"jsonrpc":"2.0","result":null}` {
			t.Fatalf("actual response: %s", body)
		}
		scope.AfterResponse(func(outcome ReplyOutcome) {
			if outcome != outcomes[0] {
				t.Fatalf("late completion changed: %v", outcome)
			}
			scope.AfterResponse(func(again ReplyOutcome) {
				if again != outcome {
					t.Fatal("reentrant completion changed")
				}
			})
		})
		answer.Abandon()
		if len(outcomes) != 1 {
			t.Fatalf("completion repeated: %v", outcomes)
		}
	})
}

// contract: endpoint.response.reports-its-outcome
func TestEndpointAfterResponseClassifiesFailureNotificationAndAbandonment(t *testing.T) {
	for _, mode := range []string{"write failure", "queued cancellation", "notification", "abandoned", "encoding failure"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				local, peer := net.Pipe()
				defer peer.Close()
				c := responseTestConnection(local)
				defer c.close("test ended")
				scope, answer := newReplyScope()
				var outcomes []ReplyOutcome
				scope.AfterResponse(func(outcome ReplyOutcome) { outcomes = append(outcomes, outcome) })
				req := request{ID: json.RawMessage("8")}
				expected := ReplyWriteFailed
				switch mode {
				case "notification":
					req.ID = nil
					expected = ReplyNoResponse
					(&Endpoint{}).replyWithCompletion(c, req, nil, nil, answer)
				case "abandoned":
					expected = ReplyAbandoned
					answer.Abandon()
				case "encoding failure":
					(&Endpoint{}).replyWithCompletion(c, req, make(chan int), nil, answer)
				case "queued cancellation":
					(&Endpoint{}).replyWithCompletion(c, req, nil, nil, answer)
					c.close("cancelled")
					go c.write()
				default:
					go c.write()
					(&Endpoint{}).replyWithCompletion(c, req, nil, nil, answer)
					synctest.Wait()
					if len(outcomes) != 0 {
						t.Fatal("write completed before socket outcome")
					}
					peer.Close()
				}
				synctest.Wait()
				if len(outcomes) != 1 || outcomes[0].Kind != expected {
					t.Fatalf("%s completion: %v", mode, outcomes)
				}
				if expected == ReplyWriteFailed && outcomes[0].Error == "" {
					t.Fatal("transport refusal lost its reason")
				}
				answer.Abandon()
				c.close("again")
				synctest.Wait()
				if len(outcomes) != 1 {
					t.Fatalf("completion repeated: %v", outcomes)
				}
			})
		})
	}
}
