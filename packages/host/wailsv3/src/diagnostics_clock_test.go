package host

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

type diagnosticsClockBackend struct{}

func (diagnosticsClockBackend) Windows() []WindowEntry {
	return []WindowEntry{{Window: "main"}}
}
func (diagnosticsClockBackend) HasWindow(window string) bool { return window == "main" }
func (diagnosticsClockBackend) PageRequest(string, string, json.RawMessage) (json.RawMessage, error) {
	return json.RawMessage(`null`), nil
}
func (diagnosticsClockBackend) HostStatus(string, string) (any, error) { return nil, nil }
func (diagnosticsClockBackend) HostCommand(string, string, json.RawMessage) (any, error) {
	return nil, nil
}
func (diagnosticsClockBackend) Pointer(string, PointerInput) error { return nil }
func (diagnosticsClockBackend) Key(string, KeyInput) error         { return nil }

type diagnosticsClockReply struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *RPCError       `json:"error"`
}

func sendDiagnosticsClockRequest(t *testing.T, conn net.Conn, id int) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  "diagnostics.clock",
		"params":  map[string]string{"window": "main"},
	})
	if err != nil {
		t.Fatalf("encode diagnostics.clock request: %v", err)
	}
	frame := binary.BigEndian.AppendUint32(nil, uint32(len(body)))
	if _, err := conn.Write(append(frame, body...)); err != nil {
		t.Fatalf("write diagnostics.clock request %d: %v", id, err)
	}
}

func diagnosticsClockCall(t *testing.T, conn net.Conn, id int) uint64 {
	t.Helper()
	sendDiagnosticsClockRequest(t, conn, id)
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set diagnostics.clock response deadline: %v", err)
	}
	var size [4]byte
	if _, err := io.ReadFull(conn, size[:]); err != nil {
		t.Fatalf("read diagnostics.clock response %d: %v", id, err)
	}
	response := make([]byte, binary.BigEndian.Uint32(size[:]))
	if _, err := io.ReadFull(conn, response); err != nil {
		t.Fatalf("read diagnostics.clock response body %d: %v", id, err)
	}
	var reply diagnosticsClockReply
	if err := json.Unmarshal(response, &reply); err != nil {
		t.Fatalf("decode diagnostics.clock response %s: %v", response, err)
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatalf("decode diagnostics.clock result: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("diagnostics.clock result has fields %v, want only mono_ns", result)
	}
	var monoNS string
	if err := json.Unmarshal(result["mono_ns"], &monoNS); err != nil {
		t.Fatalf("decode diagnostics.clock mono_ns: %v", err)
	}
	if reply.JSONRPC != "2.0" || reply.ID != id || reply.Error != nil {
		t.Fatalf("diagnostics.clock response %+v, want JSON-RPC success for id %d", reply, id)
	}
	value, err := strconv.ParseUint(monoNS, 10, 64)
	if err != nil || value == 0 || strconv.FormatUint(value, 10) != monoNS {
		t.Fatalf("mono_ns %q is not a canonical positive uint64 decimal: %v", monoNS, err)
	}
	return value
}

// contract: endpoint.diagnostics.clock, endpoint.diagnostics-clock.real-jsonrpc-returns-monotonic-decimal, endpoint.diagnostics-clock.absent-without-diagnostics
func TestDiagnosticClockMatchesBuildConfiguration(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for endpoint: %v", err)
	}
	endpoint := NewEndpoint(diagnosticsClockBackend{})
	config := t.TempDir()
	info := EndpointInfo{Transport: "tcp", Address: listener.Addr().String(), PID: 1, Application: "wailsv3", Version: "0.0.1"}
	if err := endpoint.Serve(listener, info, config); err != nil {
		if closeErr := listener.Close(); closeErr != nil {
			t.Fatalf("serve endpoint: %v; close listener: %v", err, closeErr)
		}
		t.Fatalf("serve endpoint: %v", err)
	}
	t.Cleanup(func() {
		if err := endpoint.Close(); err != nil {
			t.Errorf("close endpoint: %v", err)
		}
	})
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("connect to endpoint: %v", err)
	}
	t.Cleanup(func() {
		if err := conn.Close(); err != nil {
			t.Errorf("close endpoint connection: %v", err)
		}
	})
	if !diagnosticPlugins {
		sendDiagnosticsClockRequest(t, conn, 1)
		if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			t.Fatalf("set diagnostics.clock release response deadline: %v", err)
		}
		var size [4]byte
		if _, err := io.ReadFull(conn, size[:]); err != io.EOF {
			t.Fatalf("diagnostics.clock in a release build: read error %v, want closed connection", err)
		}
		return
	}
	first := diagnosticsClockCall(t, conn, 1)
	second := diagnosticsClockCall(t, conn, 2)
	if second < first {
		t.Fatalf("monotonic clock moved backward from %d to %d", first, second)
	}
}
