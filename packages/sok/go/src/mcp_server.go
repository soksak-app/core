package sok

// `sok mcp [window]`: the stdio MCP server that serves the endpoint of the application to an agent (docs/spec/cli.md#mcp-server).
// It uses the official MCP library of Go for the protocol, registers the fixed tools of mcp.json with their input schemas as
// they are, and reads the live exposure through the endpoint at each call. The Rust implementation (packages/sok/rust/src/
// mcp_server.rs) gives the same tools, results and error texts.

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// mcpSource is agents/mcp.json (docs/spec/cli.md#agent-sources).
//
//go:embed agents/mcp.json
var mcpSource []byte

// mcpProtocolVersions are the revisions whose messages the contract cases state; the library also answers earlier ones unless it
// is given this list.
var mcpProtocolVersions = []string{"2026-07-28", "2025-11-25"}

// mcpTool is one tool of mcp.json.
type mcpTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// mcpDefinition is mcp.json.
type mcpDefinition struct {
	Instructions string    `json:"instructions"`
	Tools        []mcpTool `json:"tools"`
}

// toolArguments are the arguments of one call, checked against the input schema of its tool.
type toolArguments map[string]json.RawMessage

func (a toolArguments) has(name string) bool { _, ok := a[name]; return ok }

func (a toolArguments) text(name string) string {
	var value string
	json.Unmarshal(a[name], &value)
	return value
}

// checkArguments reads the arguments of a call; each keeps its JSON text of the call, which reaches the endpoint as it is. The
// check covers the names, the JSON types of the properties and the required arguments of the input schema; the values are judged
// by the endpoint. It is written here and not taken from a schema library, because the error texts must be the same in the Go
// and the Rust server, and the libraries of the two languages word them differently.
func checkArguments(schema json.RawMessage, raw json.RawMessage) (toolArguments, error) {
	var declared struct {
		Properties map[string]struct {
			Type string `json:"type"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(schema, &declared); err != nil {
		return nil, fmt.Errorf("the input schema is not readable: %w", err)
	}
	args := toolArguments{}
	// Arguments that are no object were answered before the call reached its tool (mcpRefusal).
	if len(raw) > 0 && string(raw) != "null" {
		members, _, err := orderedMembers(raw)
		if err != nil {
			return nil, err
		}
		args = members
	}
	names := make([]string, 0, len(args))
	for name := range args {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		property, ok := declared.Properties[name]
		if !ok {
			return nil, fmt.Errorf("unknown argument %s", name)
		}
		if property.Type != "" && !jsonTypeIs(args[name], property.Type) {
			return nil, fmt.Errorf("%s must be %s", name, typeArticle(property.Type))
		}
	}
	for _, name := range declared.Required {
		if !args.has(name) {
			return nil, fmt.Errorf("%s is required", name)
		}
	}
	return args, nil
}

// unknownTool answers a tools/call whose tool mcp.json does not list as the handler of rmcp answers it in the Rust implementation
// (docs/spec/cli.md#mcp-server): the JSON-RPC error -32602 "unknown tool <name>", with the id of the call.
func unknownTool(params *mcp.CallToolParamsRaw, tools map[string]bool) error {
	var name string
	if params != nil {
		name = params.Name
	}
	if tools[name] {
		return nil
	}
	return &jsonrpc.Error{Code: jsonrpc.CodeInvalidParams, Message: "unknown tool " + name}
}

// mcpLineLimit is the greatest length of one message line, the bound of the stdio transports of both libraries.
const mcpLineLimit = 16 * 1024 * 1024

// mcpInput passes the message lines of in to the library through a pipe and answers the lines that mcpRefusal refuses on out
// itself (docs/spec/cli.md#mcp-server). The library writes each message to out in one Write, and lockedWriter writes each Write
// whole, so an answer of the input never falls inside a message of the library. ended gives the error that ended the input, such
// as a line longer than mcpLineLimit, once the input ended, and nil before.
func mcpInput(in io.Reader, out io.Writer, report func(string)) (transport *mcp.IOTransport, ended func() error) {
	reader, writer := io.Pipe()
	calls := &openCalls{cancelled: map[string]bool{}}
	output := &lockedWriter{out: out, calls: calls}
	result := make(chan error, 1)
	Go("mcp input", func() {
		err := filterMessages(in, writer, output, calls, report)
		result <- err
		writer.CloseWithError(err)
	})
	ended = func() error {
		select {
		case err := <-result:
			return err
		default:
			return nil
		}
	}
	return &mcp.IOTransport{Reader: reader, Writer: output}, ended
}

// openCalls holds the requests of the client that the library has not answered yet, each with whether the client cancelled it. A
// cancelled call gets no answer (docs/spec/cli.md#mcp-server): the library of Go writes the answer of every call, also of a call
// whose cancellation it received, so the server drops that answer when the library writes it.
type openCalls struct {
	mu        sync.Mutex
	cancelled map[string]bool
}

// messageHead is the part of a message line that names a request, its answer or a cancellation.
type messageHead struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params struct {
		RequestID json.RawMessage `json:"requestId"`
	} `json:"params"`
}

// read notes a request of the client, and the cancellation of a request that is open, from a line that the library will read.
func (c *openCalls) read(line []byte) {
	var head messageHead
	if json.Unmarshal(line, &head) != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(head.ID) > 0 && head.Method != "" {
		c.cancelled[string(head.ID)] = false
	} else if head.Method == "notifications/cancelled" && len(head.Params.RequestID) > 0 {
		if _, open := c.cancelled[string(head.Params.RequestID)]; open {
			c.cancelled[string(head.Params.RequestID)] = true
		}
	}
}

// answered ends the call that the answer data names and tells whether the client had cancelled it.
func (c *openCalls) answered(data []byte) bool {
	var head messageHead
	if json.Unmarshal(data, &head) != nil || len(head.ID) == 0 || head.Method != "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	cancelled := c.cancelled[string(head.ID)]
	delete(c.cancelled, string(head.ID))
	return cancelled
}

// lockedWriter writes each Write to out whole, one at a time, except the answer of a call that the client cancelled.
type lockedWriter struct {
	mu    sync.Mutex
	out   io.Writer
	calls *openCalls
}

func (w *lockedWriter) Write(data []byte) (int, error) {
	if w.calls.answered(data) {
		return len(data), nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.out.Write(data)
}

func (w *lockedWriter) Close() error { return nil }

// filterMessages copies the lines of in to pass until in ends, except a line that mcpRefusal refuses: its answer goes to out, and
// a refused line without an answer is reported. A line longer than mcpLineLimit ends the input with an error.
func filterMessages(in io.Reader, pass io.Writer, out io.Writer, calls *openCalls, report func(string)) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), mcpLineLimit)
	for scanner.Scan() {
		line := scanner.Bytes()
		answer, reason := mcpRefusal(line)
		switch {
		case answer != nil:
			if _, err := out.Write(answer); err != nil {
				return err
			}
		case reason != "":
			report("sok: mcp: " + reason)
		default:
			calls.read(line)
			if _, err := pass.Write(append(line, '\n')); err != nil {
				return err
			}
		}
	}
	if errors.Is(scanner.Err(), bufio.ErrTooLong) {
		return fmt.Errorf("mcp message exceeds %d bytes", mcpLineLimit)
	}
	return scanner.Err()
}

// mcpParseError is the answer to a line that is not valid UTF-8 or not valid JSON: the JSON-RPC parse error, whose id is null
// because no id of the line can be read.
var mcpParseError = []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}` + "\n")

// mcpDepthLimit is the deepest nesting of arrays and objects that a message line may have. serde_json, which rmcp reads each line
// with, refuses a value that enters its 128th level, while encoding/json reads 10000 levels, so both servers refuse a deeper line
// as a parse error before the library reads it.
const mcpDepthLimit = 127

// nestingDepth is the deepest nesting of arrays and objects of a valid JSON text: the brackets and braces outside strings.
func nestingDepth(text []byte) int {
	depth, deepest := 0, 0
	inString, escaped := false, false
	for _, b := range text {
		switch {
		case inString:
			switch {
			case escaped:
				escaped = false
			case b == '\\':
				escaped = true
			case b == '"':
				inString = false
			}
		case b == '"':
			inString = true
		case b == '[' || b == '{':
			depth++
			deepest = max(deepest, depth)
		case b == ']' || b == '}':
			depth--
		}
	}
	return deepest
}

// mcpRefusal judges one message line before the library reads it, for the rules that the libraries of Go and Rust apply
// differently or not at all (docs/spec/cli.md#mcp-server): a string of the message with a lone surrogate escape, which
// encoding/json decodes to U+FFFD and serde_json refuses with the whole line, and a tools/call without a string name or with
// arguments that are present, not null and no object, which the Go library refuses with its decoding error and rmcp reads as
// a custom request. A request is answered with the JSON-RPC error -32602 and its id; a message that has no id to answer is
// refused with the reason, which the server reports. A line that is not valid UTF-8, not valid JSON or nested deeper than
// mcpDepthLimit is answered with the parse error, which go-sdk would answer by ending the session and rmcp by ignoring the line;
// the UTF-8 check comes first, because encoding/json replaces each invalid byte with U+FFFD. A JSON value that is no object passes,
// and the library judges it.
func mcpRefusal(line []byte) (answer []byte, reason string) {
	if !utf8.Valid(line) || !json.Valid(line) || nestingDepth(line) > mcpDepthLimit {
		return mcpParseError, ""
	}
	members, _, err := orderedMembers(line)
	if err != nil {
		return nil, ""
	}
	refuse := func(text string) ([]byte, string) {
		id := members["id"]
		if members["method"] == nil || !jsonTypeIs(id, "string") && !jsonTypeIs(id, "number") || loneSurrogate(id) {
			return nil, text
		}
		answer, err := json.Marshal(map[string]any{
			"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": jsonrpc.CodeInvalidParams, "message": text},
		})
		if err != nil {
			return nil, text + "; " + err.Error()
		}
		return append(answer, '\n'), ""
	}
	if path, found := surrogatePath(line, ""); found {
		return refuse(path + " holds a lone surrogate escape")
	}
	var method string
	if json.Unmarshal(members["method"], &method) != nil || method != "tools/call" || members["id"] == nil {
		return nil, ""
	}
	params, _, err := orderedMembers(members["params"])
	if err != nil || !jsonTypeIs(params["name"], "string") {
		return refuse("name must be a string")
	}
	if arguments := params["arguments"]; arguments != nil && string(arguments) != "null" && !jsonTypeIs(arguments, "object") {
		return refuse("arguments must be an object")
	}
	return nil, ""
}

// surrogatePath finds the first string of a JSON text, a member name or a value, that holds a lone surrogate escape and returns
// its path: the member names as written, joined by dots, and [n] for the item n of an array. No JSON library reports the path of
// such a string: encoding/json decodes the escape to U+FFFD, so the walk reads each string as written through the offsets of
// the decoder.
func surrogatePath(text []byte, path string) (string, bool) {
	text = bytes.TrimSpace(text)
	if len(text) == 0 {
		return "", false
	}
	member := func(name string) string {
		if path == "" {
			return name
		}
		return path + "." + name
	}
	switch text[0] {
	case '"':
		return path, loneSurrogate(text)
	case '{', '[':
	default:
		return "", false
	}
	decoder := json.NewDecoder(bytes.NewReader(text))
	if _, err := decoder.Token(); err != nil {
		return "", false
	}
	for n := 0; decoder.More(); n++ {
		inner := fmt.Sprintf("%s[%d]", path, n)
		if text[0] == '{' {
			start := decoder.InputOffset()
			if _, err := decoder.Token(); err != nil {
				return "", false
			}
			written := text[start:decoder.InputOffset()]
			written = written[bytes.IndexByte(written, '"'):]
			inner = member(string(written[1 : len(written)-1]))
			if loneSurrogate(written) {
				return inner, true
			}
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return "", false
		}
		if found, ok := surrogatePath(value, inner); ok {
			return found, true
		}
	}
	return "", false
}

// jsonTypeIs tells whether value is of the JSON schema type kind.
func jsonTypeIs(value json.RawMessage, kind string) bool {
	var decoded any
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.UseNumber()
	if decoder.Decode(&decoded) != nil {
		return false
	}
	switch v := decoded.(type) {
	case string:
		return kind == "string"
	case bool:
		return kind == "boolean"
	case json.Number:
		if kind == "number" {
			return true
		}
		_, err := strconv.ParseInt(string(v), 10, 64)
		return kind == "integer" && err == nil
	case map[string]any:
		return kind == "object"
	case []any:
		return kind == "array"
	}
	return false
}

func typeArticle(kind string) string {
	switch kind {
	case "integer", "object", "array":
		return "an " + kind
	}
	return "a " + kind
}

// endpointConnection is one endpoint connection of the server. Requests of several calls share it: each request has its own id,
// and the reader passes each answer to its request and each notification to the watches.
type endpointConnection struct {
	client *Client
	write  sync.Mutex

	mu      sync.Mutex
	nextID  int
	pending map[int]chan endpointAnswer
	ended   error
	// done is closed when the reader of the connection has ended every request and watch of it.
	done chan struct{}
}

type endpointAnswer struct {
	result json.RawMessage
	err    error
}

// request sends method and waits for its answer or the end of the connection.
func (c *endpointConnection) request(method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	if c.ended != nil {
		c.mu.Unlock()
		return nil, c.ended
	}
	id := c.nextID
	c.nextID++
	answer := make(chan endpointAnswer, 1)
	c.pending[id] = answer
	c.mu.Unlock()
	frame := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		frame["params"] = params
	}
	c.write.Lock()
	err := c.client.write(frame)
	c.write.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}
	got := <-answer
	return got.result, got.err
}

// mcpServer is the state of one `sok mcp`.
type mcpServer struct {
	configDir string
	// window and project are the [window] of the start.
	window, project string
	hasWindow       bool
	stderr          io.Writer

	mu         sync.Mutex
	connection *endpointConnection
	watches    map[watchKey]*statusWatch
	// closing tells that the server closes its connection at its end, so the end of that connection is no failure to report.
	closing bool
	// reportErr is the first failure to write a line to standard error; the server returns it at its end.
	reportErr error
}

// watchKey names one endpoint watch: a window, a status and a surface ("" for none).
type watchKey struct{ window, name, surface string }

// statusWatch is one endpoint watch that the waiting calls of status_watch_once share.
type statusWatch struct {
	key        watchKey
	connection *endpointConnection
	waiters    map[*watchWaiter]bool
	// known tells whether value holds the current value: the reply of status.get, or a later change.
	known   bool
	changed bool
	value   json.RawMessage
	// ended tells that the endpoint holds the watch no longer, so no status.unwatch is sent.
	ended bool
}

// watchWaiter is one call of status_watch_once.
type watchWaiter struct {
	equals    any
	hasEquals bool
	outcome   chan endpointAnswer
}

func (w *watchWaiter) settle(result json.RawMessage, err error) {
	select {
	case w.outcome <- endpointAnswer{result, err}:
	default:
	}
}

// endpoint returns the open connection, or connects to the endpoint of the configuration directory.
func (s *mcpServer) endpoint() (*endpointConnection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.connection != nil {
		s.connection.mu.Lock()
		ended := s.connection.ended
		s.connection.mu.Unlock()
		if ended == nil {
			return s.connection, nil
		}
		s.connection = nil
	}
	endpoint, err := ReadEndpoint(s.configDir)
	if err != nil {
		return nil, err
	}
	client, err := Dial(endpoint)
	if err != nil {
		return nil, err
	}
	connection := &endpointConnection{client: client, nextID: 1, pending: map[int]chan endpointAnswer{}, done: make(chan struct{})}
	s.connection = connection
	Go("mcp endpoint", func() { s.read(connection) })
	return connection, nil
}

// read passes the answers and notifications of connection until it ends, then ends every request and watch of it. It reports the
// end of the connection unless the server closed it at its own end, and a failed close in each case.
func (s *mcpServer) read(connection *endpointConnection) {
	defer close(connection.done)
	var reason error
	for {
		m, err := connection.client.read()
		if err != nil {
			reason = err
			break
		}
		if m.ID == nil {
			s.notified(connection, m.Method, m.Params)
			continue
		}
		connection.mu.Lock()
		answer, ok := connection.pending[*m.ID]
		delete(connection.pending, *m.ID)
		connection.mu.Unlock()
		if !ok {
			reason = fmt.Errorf("endpoint sent an answer to request %d that is not pending", *m.ID)
			break
		}
		if m.Error != nil {
			answer <- endpointAnswer{err: m.Error}
		} else if len(m.Result) == 0 {
			answer <- endpointAnswer{result: json.RawMessage("null")}
		} else {
			answer <- endpointAnswer{result: m.Result}
		}
	}
	closeErr := connection.client.Close()
	connection.mu.Lock()
	connection.ended = reason
	pending := connection.pending
	connection.pending = map[int]chan endpointAnswer{}
	connection.mu.Unlock()
	for _, answer := range pending {
		answer <- endpointAnswer{err: reason}
	}
	s.mu.Lock()
	for key, watch := range s.watches {
		if watch.connection == connection {
			watch.ended = true
			delete(s.watches, key)
			for waiter := range watch.waiters {
				waiter.settle(nil, reason)
			}
		}
	}
	closing := s.closing
	s.mu.Unlock()
	if !closing {
		s.report("sok: mcp: %v", reason)
	}
	if closeErr != nil {
		s.report("sok: mcp: %v", closeErr)
	}
}

// report writes one line to standard error and keeps the first failure to write it, which the server returns at its end.
func (s *mcpServer) report(format string, args ...any) {
	_, err := fmt.Fprintf(s.stderr, format+"\n", args...)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil && s.reportErr == nil {
		s.reportErr = err
	}
}

// notified passes status.changed and status.ended to the watch that they name.
func (s *mcpServer) notified(connection *endpointConnection, method string, raw json.RawMessage) {
	if method != "status.changed" && method != "status.ended" {
		return
	}
	var params struct {
		Window  string          `json:"window"`
		Name    string          `json:"name"`
		Surface string          `json:"surface"`
		Value   json.RawMessage `json:"value"`
		Reason  string          `json:"reason"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		s.report("sok: mcp: %s has unexpected params: %v", method, err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := watchKey{params.Window, params.Name, params.Surface}
	watch, ok := s.watches[key]
	if !ok || watch.connection != connection {
		return
	}
	if method == "status.ended" {
		watch.ended = true
		delete(s.watches, key)
		for waiter := range watch.waiters {
			waiter.settle(nil, fmt.Errorf("status %s ended: %s", params.Name, params.Reason))
		}
		return
	}
	value := params.Value
	if value == nil {
		value = json.RawMessage("null")
	}
	watch.known, watch.changed, watch.value = true, true, value
	for waiter := range watch.waiters {
		if !waiter.hasEquals || sameValue(value, waiter.equals) {
			waiter.settle(value, nil)
		}
	}
}

// sameValue compares a status value with the value of equals as JSON values; numbers compare by their value.
func sameValue(value json.RawMessage, equals any) bool {
	var decoded any
	if json.Unmarshal(value, &decoded) != nil {
		return false
	}
	return reflect.DeepEqual(decoded, equals)
}

// selectWindow is the window of a call: its window argument, else the [window] of the start, else the window of the surface that
// SOKSAK_SURFACE names, else the key window of windows.list, else its first window (docs/spec/cli.md#mcp-server). It returns the
// window and the space of the agent's surface too when it asked for them, so a description does not ask twice.
func (s *mcpServer) selectWindow(request requester, args toolArguments) (window string, home *surfaceHome, err error) {
	if args.has("window") {
		return args.text("window"), nil, nil
	}
	if s.hasWindow {
		if s.project == "" {
			return s.window, nil, nil
		}
		windows, err := readWindows(request)
		if err != nil {
			return "", nil, err
		}
		window, err := projectWindow(windows, s.project)
		return window, nil, err
	}
	if surface := agentSurface(); surface != "" {
		found, err := surfaceWindow(request, surface)
		if err != nil {
			return "", nil, err
		}
		return found.Window, &found, nil
	}
	window, err = keyWindow(request)
	return window, nil, err
}

// withArguments is the params of an endpoint request: the window and each named argument of the call that is present.
func withArguments(window string, args toolArguments, names ...string) map[string]any {
	params := map[string]any{"window": window}
	for _, name := range names {
		if value, ok := args[name]; ok {
			params[name] = value
		}
	}
	return params
}

// call runs one tool. Its result is the JSON text of the tool result, or the error that is the text of the tool error.
func (s *mcpServer) call(ctx context.Context, name string, args toolArguments) ([]byte, error) {
	// The values that the server itself reads are checked before the first endpoint request.
	limit := 0
	switch name {
	case "exposure_search", "exposure_describe":
		if kind := args.text("kind"); args.has("kind") && kind != "status" && kind != "command" && kind != "element" {
			return nil, errors.New("kind must be status, command or element")
		}
		if name == "exposure_search" {
			var err error
			if limit, err = limitArgument(args, 50, 200); err != nil {
				return nil, err
			}
		}
	case "window_describe":
		var err error
		if limit, err = limitArgument(args, describeDefaultLimit, describeMaxLimit); err != nil {
			return nil, err
		}
	}
	if name == "agent_context" && agentSurface() == "" {
		context, err := agentContext(nil, s.configDir)
		if err != nil {
			return nil, err
		}
		return encodeJSON(context)
	}
	connection, err := s.endpoint()
	if err != nil {
		return nil, err
	}
	request := connection.request
	passed := func(result json.RawMessage, err error) ([]byte, error) {
		if err != nil {
			return nil, err
		}
		return compactRaw(result)
	}
	switch name {
	case "windows_list":
		return passed(request("windows.list", nil))
	case "agent_context":
		context, err := agentContext(request, s.configDir)
		if err != nil {
			return nil, err
		}
		return encodeJSON(context)
	}
	if name == "messages_read" || name == "messages_wait" {
		return messagesCall(ctx, connection, strings.TrimPrefix(name, "messages_"), args)
	}
	window, home, err := s.selectWindow(request, args)
	if err != nil {
		return nil, err
	}
	switch name {
	case "window_describe":
		return describeRequest(request, window, home, args.text("surface"), string(args["full"]) == "true", args.text("after"), limit)
	case "exposure_search", "exposure_describe":
		result, err := request("exposure.list", map[string]any{"window": window})
		if err != nil {
			return nil, err
		}
		read, err := readExposure(result)
		if err != nil {
			return nil, err
		}
		kind := args.text("kind")
		if name == "exposure_describe" {
			return describeEntry(read, kind, args.text("name"))
		}
		found, err := searchExposure(read, kind, args.text("query"), args.text("after"), limit)
		if err != nil {
			return nil, err
		}
		return encodeJSON(found)
	case "command_run":
		params := withArguments(window, args, "surface", "name")
		params["params"] = json.RawMessage("{}")
		if value, ok := args["params"]; ok {
			params["params"] = value
		}
		return passed(request("command.run", params))
	case "status_get":
		return passed(request("status.get", withArguments(window, args, "name", "surface")))
	case "status_watch_once":
		return s.watchOnce(ctx, connection, window, args)
	case "element_rect":
		return passed(request("element.rect", withArguments(window, args, "name", "surface", "index")))
	case "element_act":
		return passed(request("element.act", withArguments(window, args, "name", "surface", "index", "action", "value", "event")))
	case "input_pointer":
		return passed(request("input.pointer", withArguments(window, args, "x", "y", "phase", "button", "deltaX", "deltaY", "clicks", "activate")))
	case "input_key":
		return passed(request("input.key", withArguments(window, args, "key", "text", "modifiers", "phase")))
	case "input_text":
		return passed(request("input.text", withArguments(window, args, "phase", "text", "selection", "replacement")))
	}
	return nil, fmt.Errorf("unknown tool %s", name)
}

// messagesCall runs messages_read or messages_wait (docs/spec/messaging.md#path-of-the-reads): the window of the terminal from
// surface.window, its plugin from the group of the surface in exposure.snapshot, and command.run of <plugin>.messages.<operation> on
// the surface. The call has no time limit; a cancelled call ends without a result and leaves its endpoint request open, whose later
// answer the reader of the connection discards.
func messagesCall(ctx context.Context, connection *endpointConnection, operation string, args toolArguments) ([]byte, error) {
	terminal := args.text("terminal")
	result, err := connection.request("surface.window", map[string]any{"surface": terminal})
	var endpointErr *EndpointError
	if errors.As(err, &endpointErr) && endpointErr.Code == 1012 {
		return nil, fmt.Errorf("unknown-terminal: surface %s is in no window", terminal)
	}
	if err != nil {
		return nil, err
	}
	var home struct {
		Window string `json:"window"`
	}
	if json.Unmarshal(result, &home) != nil || home.Window == "" {
		return nil, fmt.Errorf("surface.window returned an unexpected value: %s", result)
	}
	result, err = connection.request("exposure.snapshot", map[string]any{"window": home.Window, "surface": terminal})
	if err != nil {
		return nil, err
	}
	var snapshot struct {
		Groups []struct {
			Owner    string `json:"owner"`
			Surface  string `json:"surface"`
			Plugin   string `json:"plugin"`
			Commands []struct {
				Name string `json:"name"`
			} `json:"commands"`
		} `json:"groups"`
	}
	if json.Unmarshal(result, &snapshot) != nil {
		return nil, fmt.Errorf("exposure.snapshot returned an unexpected value: %s", result)
	}
	for _, group := range snapshot.Groups {
		if group.Owner != "surface" || group.Surface != terminal {
			continue
		}
		command := group.Plugin + ".messages." + operation
		registered := false
		for _, entry := range group.Commands {
			registered = registered || entry.Name == command
		}
		if !registered {
			return nil, fmt.Errorf("unknown-terminal: surface %s of plugin %s registers no command %s", terminal, group.Plugin, command)
		}
		params := map[string]any{}
		for _, member := range []string{"after", "registration"} {
			if value, ok := args[member]; ok {
				params[member] = value
			}
		}
		answer := make(chan endpointAnswer, 1)
		Go("mcp messages", func() {
			result, err := connection.request("command.run", map[string]any{"window": home.Window, "surface": terminal, "name": command, "params": params})
			answer <- endpointAnswer{result, err}
		})
		select {
		case got := <-answer:
			if got.err != nil {
				return nil, got.err
			}
			return compactRaw(got.result)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return nil, fmt.Errorf("exposure.snapshot of window %s holds no group of surface %s", home.Window, terminal)
}

// limitArgument reads limit, an integer from 1 to max with the default fallback when it is absent.
func limitArgument(args toolArguments, fallback, max int) (int, error) {
	if !args.has("limit") {
		return fallback, nil
	}
	limit, err := strconv.Atoi(string(args["limit"]))
	if err != nil || limit < 1 || limit > max {
		return 0, fmt.Errorf("limit must be an integer from 1 to %d", max)
	}
	return limit, nil
}

// describeRequest asks for the window and the space of the agent's surface when they are not known yet, then for the snapshot, and
// writes the page.
func describeRequest(request requester, window string, home *surfaceHome, surface string, full bool, after string, limit int) ([]byte, error) {
	var agent any
	if own := agentSurface(); own != "" {
		if home == nil {
			found, err := surfaceWindow(request, own)
			if err != nil && !isNoWindowOf(err) {
				return nil, err
			}
			if err == nil {
				home = &found
			}
		}
		if home != nil && home.Window == window {
			agent = own
		}
	}
	params := map[string]any{"window": window}
	if surface != "" {
		params["surface"] = surface
	}
	snapshot, err := request("exposure.snapshot", params)
	if err != nil {
		return nil, err
	}
	if own, ok := agent.(string); ok {
		var parts struct {
			Layout json.RawMessage `json:"layout"`
		}
		if err := json.Unmarshal(snapshot, &parts); err != nil {
			return nil, fmt.Errorf("exposure.snapshot returned an unexpected value: %w", err)
		}
		place, err := agentPlace(parts.Layout, own, home.Space)
		if err != nil {
			return nil, err
		}
		agent = place
	}
	return describeWindow(snapshot, agent, full, after, limit)
}

// skillFailures are the failures to bring the skill current: each entry of SkillWriteErrors, else the error itself.
func skillFailures(err error) []error {
	var writes SkillWriteErrors
	if errors.As(err, &writes) {
		return writes.Unwrap()
	}
	return []error{err}
}

// skillFailure are the fields of sok.skill for one failure to bring the skill current: the skill file of a *SkillWriteError with
// the reason of the operating system, else no file and the whole text as the reason.
func skillFailure(err error) map[string]any {
	var write *SkillWriteError
	if errors.As(err, &write) {
		return map[string]any{"file": write.File, "reason": write.Err.Error()}
	}
	return map[string]any{"reason": err.Error()}
}

// isNoWindowOf tells whether err is the error of a surface in no window.
func isNoWindowOf(err error) bool {
	return err != nil && err.Error() == fmt.Sprintf("%s names surface %s, which is in no window of the application", SurfaceVariable, agentSurface())
}

// watchOnce is status_watch_once: the calls that wait on one status of a window and surface share one endpoint watch, and the
// last of them to end sends status.unwatch.
func (s *mcpServer) watchOnce(ctx context.Context, connection *endpointConnection, window string, args toolArguments) ([]byte, error) {
	key := watchKey{window, args.text("name"), args.text("surface")}
	waiter := &watchWaiter{outcome: make(chan endpointAnswer, 1)}
	if raw, ok := args["equals"]; ok {
		waiter.hasEquals = true
		if err := json.Unmarshal(raw, &waiter.equals); err != nil {
			return nil, fmt.Errorf("equals is not a JSON value: %w", err)
		}
	}
	target := map[string]any{"window": window, "name": key.name}
	if args.has("surface") {
		target["surface"] = key.surface
	}
	s.mu.Lock()
	watch, shared := s.watches[key]
	if shared && watch.connection != connection {
		shared = false
	}
	if !shared {
		watch = &statusWatch{key: key, connection: connection, waiters: map[*watchWaiter]bool{}}
		if s.watches == nil {
			s.watches = map[watchKey]*statusWatch{}
		}
		s.watches[key] = watch
	}
	watch.waiters[waiter] = true
	if shared && watch.known && waiter.hasEquals && sameValue(watch.value, waiter.equals) {
		waiter.settle(watch.value, nil)
	}
	s.mu.Unlock()
	if !shared {
		if _, err := connection.request("status.watch", target); err != nil {
			s.endWatch(watch, err)
		} else if value, err := connection.request("status.get", target); err != nil {
			s.failWatch(watch, err)
		} else {
			s.mu.Lock()
			if !watch.changed && !watch.ended {
				watch.known, watch.value = true, value
				for other := range watch.waiters {
					if other.hasEquals && sameValue(value, other.equals) {
						other.settle(value, nil)
					}
				}
			}
			s.mu.Unlock()
		}
	}
	var outcome endpointAnswer
	select {
	case outcome = <-waiter.outcome:
	case <-ctx.Done():
		outcome.err = ctx.Err()
	}
	if err := s.leave(watch, waiter, target); err != nil && outcome.err == nil {
		return nil, err
	}
	if outcome.err != nil {
		return nil, outcome.err
	}
	return compactRaw(outcome.result)
}

// endWatch ends the waiters of a watch that the endpoint did not start, so no status.unwatch follows.
func (s *mcpServer) endWatch(watch *statusWatch, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	watch.ended = true
	if s.watches[watch.key] == watch {
		delete(s.watches, watch.key)
	}
	for waiter := range watch.waiters {
		waiter.settle(nil, err)
	}
}

// failWatch ends the waiters of a started watch with err; the last of them ends the watch with status.unwatch.
func (s *mcpServer) failWatch(watch *statusWatch, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for waiter := range watch.waiters {
		waiter.settle(nil, err)
	}
}

// leave removes waiter from its watch; the last waiter of a watch that the endpoint still holds sends status.unwatch.
func (s *mcpServer) leave(watch *statusWatch, waiter *watchWaiter, target map[string]any) error {
	s.mu.Lock()
	delete(watch.waiters, waiter)
	last := len(watch.waiters) == 0 && !watch.ended
	if last {
		watch.ended = true
		if s.watches[watch.key] == watch {
			delete(s.watches, watch.key)
		}
	}
	s.mu.Unlock()
	if !last {
		return nil
	}
	_, err := watch.connection.request("status.unwatch", target)
	return err
}

// runMCP serves MCP on standard input and output until standard input ends.
func runMCP(a arguments, stderr io.Writer, options Options) error {
	if len(a.positionals) > 1 {
		return usage("mcp takes no argument besides [window]")
	}
	configDir, err := configDirOf(a.values, options)
	if err != nil {
		return err
	}
	_, byName := a.values["window"]
	project, byProject := a.values["project"]
	if byName && byProject {
		return usage("--window and --project select the window in two ways; give one")
	}
	// The server brings the skill current before it reads the first message (docs/spec/cli.md#mcp-server); no agent folder is no
	// error here, and each failure is written to standard error and stored as sok.skill while the server starts in each case.
	if _, err := (Setup{Environment: ProcessAgentEnvironment()}).InstallSkills(); err != nil {
		var none *NoAgentFolderError
		if !errors.As(err, &none) {
			for _, failure := range skillFailures(err) {
				if log := runLog.Load(); log != nil {
					log.Emit(LevelError, "sok.skill", skillFailure(failure))
				}
				if _, writeErr := fmt.Fprintf(stderr, "sok: skill: %v\n", failure); writeErr != nil {
					return writeErr
				}
			}
		}
	}
	var definition mcpDefinition
	if err := json.Unmarshal(mcpSource, &definition); err != nil {
		return invalidJSON("mcp.json", mcpSource, err)
	}
	state := &mcpServer{configDir: configDir, window: a.values["window"], project: project, hasWindow: byName || byProject, stderr: stderr}
	server := mcp.NewServer(&mcp.Implementation{Name: "soksak", Version: options.CoreVersion}, &mcp.ServerOptions{
		Instructions:              definition.Instructions,
		Logger:                    slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: slog.LevelWarn})),
		Capabilities:              &mcp.ServerCapabilities{Tools: &mcp.ToolCapabilities{ListChanged: false}},
		SupportedProtocolVersions: mcpProtocolVersions,
	})
	tools := map[string]bool{}
	for _, tool := range definition.Tools {
		tools[tool.Name] = true
	}
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
			if call, ok := request.(*mcp.CallToolRequest); ok {
				if err := unknownTool(call.Params, tools); err != nil {
					return nil, err
				}
			}
			return next(ctx, method, request)
		}
	})
	for _, tool := range definition.Tools {
		schema := tool.InputSchema
		name := tool.Name
		server.AddTool(&mcp.Tool{Name: tool.Name, Description: tool.Description, InputSchema: schema}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args, err := checkArguments(schema, request.Params.Arguments)
			var text []byte
			if err == nil {
				text, err = state.call(ctx, name, args)
			}
			if err != nil {
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}, IsError: true}, nil
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(text)}}}, nil
		})
	}
	transport, inputEnded := mcpInput(os.Stdin, os.Stdout, func(line string) { state.report("%s", line) })
	err = server.Run(context.Background(), transport)
	// The server closes its connection and waits until the reader ended it, which reports a failed close.
	state.mu.Lock()
	state.closing = true
	connection := state.connection
	state.mu.Unlock()
	if connection != nil {
		connection.client.Close()
		<-connection.done
	}
	// The input that ended with an error, a line longer than mcpLineLimit or a failed read, ended the server with it.
	if inputErr := inputEnded(); inputErr != nil {
		return inputErr
	}
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
		return err
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.reportErr
}
