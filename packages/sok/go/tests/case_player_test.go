package tests

// Plays one endpoint contract case (docs/spec/endpoint.md#checks, docs/spec/cases/endpoint) for the tests of sok. The player writes
// endpoint.json of a configuration directory, listens on the Unix socket that the file names, sends the host frames of the case in
// their order and checks each frame of the client against the next step. It answers no frame that the case does not contain at its
// place. A frame of the client that differs from the case, a step that was not played and a connection that the client closed before
// its step are failures; the test reports them when it ends. The case player of packages/client/testing/case-player.js has the same
// rules and the same case format.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// casePlayerLimit bounds the wait for a client to close its connection, and the wait for a connection that precedes a new one.
const casePlayerLimit = 10 * time.Second

// maxCaseFrame is the largest frame body that the player accepts from the client (docs/spec/endpoint.md).
const maxCaseFrame = 16 * 1024 * 1024

var (
	caseNamePattern     = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	caseVariablePattern = regexp.MustCompile(`^\$([a-z][a-z0-9-]*)$`)
)

// caseDirectory returns docs/spec/cases/endpoint of the repository that holds this package. It walks up from this source file to the
// first directory that holds that folder, so the location is discovered and not assumed.
func caseDirectory(t *testing.T) string {
	t.Helper()
	_, here, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("the source file of the case player is unknown")
	}
	for dir := filepath.Dir(here); ; {
		candidate := filepath.Join(dir, "docs", "spec", "cases", "endpoint")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("no docs/spec/cases/endpoint folder holds %s", here)
		}
		dir = parent
	}
}

// orderedObject is a JSON object that keeps the order of its members. The output of sok keeps the order that the endpoint sends.
type orderedObject struct {
	keys   []string
	values map[string]any
}

// parseValue decodes one JSON value. Objects keep the order of their members, and numbers keep their text.
func parseValue(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := readValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after the JSON value")
	}
	return value, nil
}

func readValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return token, nil
	}
	switch delim {
	case '{':
		object := &orderedObject{values: map[string]any{}}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, fmt.Errorf("object key %v is not a string", keyToken)
			}
			member, err := readValue(decoder)
			if err != nil {
				return nil, err
			}
			if _, seen := object.values[key]; !seen {
				object.keys = append(object.keys, key)
			}
			object.values[key] = member
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return object, nil
	case '[':
		items := []any{}
		for decoder.More() {
			item, err := readValue(decoder)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return items, nil
	}
	return nil, fmt.Errorf("unexpected delimiter %v", delim)
}

// writeValue encodes a parsed value with the member order it has.
func writeValue(buffer *bytes.Buffer, value any) error {
	switch v := value.(type) {
	case *orderedObject:
		buffer.WriteByte('{')
		for n, key := range v.keys {
			if n > 0 {
				buffer.WriteByte(',')
			}
			name, err := json.Marshal(key)
			if err != nil {
				return err
			}
			buffer.Write(name)
			buffer.WriteByte(':')
			if err := writeValue(buffer, v.values[key]); err != nil {
				return err
			}
		}
		buffer.WriteByte('}')
		return nil
	case []any:
		buffer.WriteByte('[')
		for n, item := range v {
			if n > 0 {
				buffer.WriteByte(',')
			}
			if err := writeValue(buffer, item); err != nil {
				return err
			}
		}
		buffer.WriteByte(']')
		return nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	buffer.Write(data)
	return nil
}

// plain converts a parsed value to the form that encoding/json gives a decoded frame, so that a frame of the client compares equal
// to a send step of the case.
func plain(value any) (any, error) {
	switch v := value.(type) {
	case *orderedObject:
		members := make(map[string]any, len(v.keys))
		for _, key := range v.keys {
			member, err := plain(v.values[key])
			if err != nil {
				return nil, err
			}
			members[key] = member
		}
		return members, nil
	case []any:
		items := make([]any, 0, len(v))
		for _, item := range v {
			converted, err := plain(item)
			if err != nil {
				return nil, err
			}
			items = append(items, converted)
		}
		return items, nil
	case json.Number:
		number, err := v.Float64()
		return number, err
	}
	return value, nil
}

// collectVariables adds the names of the variables that a value uses.
func collectVariables(value any, names map[string]bool) {
	switch v := value.(type) {
	case string:
		if match := caseVariablePattern.FindStringSubmatch(v); match != nil {
			names[match[1]] = true
		}
	case []any:
		for _, item := range v {
			collectVariables(item, names)
		}
	case *orderedObject:
		for _, key := range v.keys {
			collectVariables(v.values[key], names)
		}
	}
}

// caseStep is one step of a case. A send step holds the frame that the client must send; reply and notify steps hold the frames of the
// host; a close step names the side that closes the connection.
type caseStep struct {
	kind string
	// value is the frame of a reply or notify step, parsed with its member order.
	value any
	// expected is the frame of a send step in the form of a decoded frame.
	expected any
	// closer names the side that closes the connection in a close step.
	closer string
	// text is the step in its JSON form, for the failure messages.
	text string
}

// caseFile is a case that passed the check of its form.
type caseFile struct {
	steps     []caseStep
	variables map[string]any
}

// loadCase reads and checks the case of the name in directory. A case that does not have the form of the case format is an error that
// names the file.
func loadCase(directory, name string) (caseFile, error) {
	file := filepath.Join(directory, name+".json")
	data, err := os.ReadFile(file)
	if err != nil {
		return caseFile{}, err
	}
	root, err := parseValue(data)
	if err != nil {
		return caseFile{}, fmt.Errorf("%s is not a readable case: %w", file, err)
	}
	fail := func(reason string) (caseFile, error) {
		return caseFile{}, fmt.Errorf("%s: %s", file, reason)
	}
	kase, ok := root.(*orderedObject)
	if !ok {
		return fail("the case is not an object")
	}
	if kase.values["name"] != name {
		return fail("name does not match the file name")
	}
	if description, ok := kase.values["description"].(string); !ok || description == "" {
		return fail("description must be a non-empty string")
	}
	replay, ok := kase.values["replay"].(bool)
	if !ok {
		return fail("replay must be true or false")
	}
	if reason, _ := kase.values["reason"].(string); !replay && reason == "" {
		return fail("a case with replay false must give its reason")
	}
	variables := map[string]any{}
	if declared, present := kase.values["variables"]; present {
		object, ok := declared.(*orderedObject)
		if !ok {
			return fail("variables must be an object")
		}
		for _, key := range object.keys {
			if !caseNamePattern.MatchString(key) {
				return fail(fmt.Sprintf("variable %s must have the form a-z, digits and hyphens", key))
			}
			spec, ok := object.values[key].(*orderedObject)
			if !ok {
				return fail(fmt.Sprintf("variable %s must be an object", key))
			}
			if _, ok := spec.values["type"]; !ok {
				return fail(fmt.Sprintf("variable %s must have a type", key))
			}
			example, ok := spec.values["example"]
			if !ok {
				return fail(fmt.Sprintf("variable %s must have an example", key))
			}
			variables[key] = example
		}
	}
	rawSteps, ok := kase.values["steps"].([]any)
	if !ok {
		return fail("steps must be an array")
	}
	var steps []caseStep
	used := map[string]bool{}
	for index, raw := range rawSteps {
		where := fmt.Sprintf("step %d", index)
		step, ok := raw.(*orderedObject)
		if !ok {
			return fail(where + " is not an object")
		}
		var kinds []string
		for _, kind := range []string{"send", "reply", "notify", "close"} {
			if _, present := step.values[kind]; present {
				kinds = append(kinds, kind)
			}
		}
		if len(kinds) != 1 {
			return fail(where + " must have exactly one of send, reply, notify and close")
		}
		kind := kinds[0]
		if kind == "close" {
			closer, _ := step.values["close"].(string)
			if closer != "host" && closer != "client" {
				return fail(where + " close must be host or client")
			}
			steps = append(steps, caseStep{kind: kind, closer: closer, text: `{"close":"` + closer + `"}`})
			continue
		}
		frame, ok := step.values[kind].(*orderedObject)
		if !ok {
			return fail(where + " " + kind + " must be an object")
		}
		if _, raw := frame.values["raw_hex"]; raw {
			return fail(where + " sends raw bytes, which this player does not play")
		}
		if frame.values["jsonrpc"] != "2.0" {
			return fail(where + " " + kind + " must have jsonrpc 2.0")
		}
		var buffer bytes.Buffer
		if err := writeValue(&buffer, frame); err != nil {
			return fail(where + ": " + err.Error())
		}
		parsed := caseStep{kind: kind, value: frame, text: buffer.String()}
		switch kind {
		case "send":
			if _, ok := frame.values["method"].(string); !ok {
				return fail(where + " send must name a method")
			}
			expected, err := plain(frame)
			if err != nil {
				return fail(where + ": " + err.Error())
			}
			parsed.expected = expected
		case "reply":
			if _, ok := frame.values["id"]; !ok {
				return fail(where + " reply must have an id")
			}
			collectVariables(frame, used)
		case "notify":
			if _, ok := frame.values["method"].(string); !ok {
				return fail(where + " notify must name a method")
			}
			if _, ok := frame.values["id"]; ok {
				return fail(where + " notify must be a notification without an id")
			}
			collectVariables(frame, used)
		}
		steps = append(steps, parsed)
	}
	for name := range used {
		if _, ok := variables[name]; !ok {
			return fail(fmt.Sprintf("variable $%s is not declared", name))
		}
	}
	return caseFile{steps: steps, variables: variables}, nil
}

// caseOption changes a case before it is played.
type caseOption func(*caseSettings)

type caseSettings struct {
	texts map[string]string
}

// withText gives the variable of the name the text that the host would choose. A test uses it for a value that depends on the
// machine it runs on, such as the folder of a project, or a value whose size the case does not state.
func withText(name, text string) caseOption {
	return func(settings *caseSettings) {
		settings.texts[name] = text
	}
}

// casePlayer is the player of one case. Its methods are safe for the goroutines of its connections.
type casePlayer struct {
	name      string
	configDir string
	socketDir string
	listener  net.Listener
	steps     []caseStep
	variables map[string]any
	texts     map[string]string

	mu sync.Mutex
	// cursor is the index of the next step.
	cursor int
	// requests are the frames of the client, in order.
	requests    []map[string]any
	connections int
	failures    []string
	closing     bool
	open        map[net.Conn]bool
	// done holds, for each connection in the order it was accepted, a channel that is closed when the connection has ended.
	done []chan struct{}
}

// playCase starts the case of the name and returns its player. The test runs its check when it ends: the test fails with every frame of
// the client that differs from the case, and with every step that was not played.
func playCase(t *testing.T, name string, options ...caseOption) *casePlayer {
	t.Helper()
	settings := caseSettings{texts: map[string]string{}}
	for _, option := range options {
		option(&settings)
	}
	p, err := startCasePlayer(t.TempDir(), caseDirectory(t), name, settings)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := p.close(); err != nil {
			t.Error(err)
		}
	})
	return p
}

// startCasePlayer writes endpoint.json of configDir and starts listening on the socket that it names.
func startCasePlayer(configDir, directory, name string, settings caseSettings) (*casePlayer, error) {
	kase, err := loadCase(directory, name)
	if err != nil {
		return nil, err
	}
	for text := range settings.texts {
		if _, declared := kase.variables[text]; !declared {
			return nil, fmt.Errorf("%s: the test gives a value for variable %s, which the case does not declare", name, text)
		}
	}
	// A Unix socket path is limited to 104 bytes. The test runner gives the process a short TMPDIR under /tmp, so the socket folder
	// lies there.
	socketDir, err := os.MkdirTemp("", "sok")
	if err != nil {
		return nil, err
	}
	address := filepath.Join(socketDir, "e.sock")
	listener, err := net.Listen("unix", address)
	if err != nil {
		os.RemoveAll(socketDir)
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		listener.Close()
		os.RemoveAll(socketDir)
		return nil, err
	}
	endpoint, err := json.Marshal(map[string]any{
		"transport":   "unix",
		"address":     address,
		"pid":         os.Getpid(),
		"application": "wailsv3",
		"version":     "0.0.40",
		"executable":  executable,
		"started":     time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		listener.Close()
		os.RemoveAll(socketDir)
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(configDir, "endpoint.json"), endpoint, 0o600); err != nil {
		listener.Close()
		os.RemoveAll(socketDir)
		return nil, err
	}
	p := &casePlayer{
		name:      name,
		configDir: configDir,
		socketDir: socketDir,
		listener:  listener,
		steps:     kase.steps,
		variables: kase.variables,
		texts:     settings.texts,
		open:      map[net.Conn]bool{},
	}
	go p.accept()
	return p, nil
}

// accept serves each connection of the client. A connection starts after the connections that precede it have ended, so the close
// step of a connection is checked before the frames of the next one.
func (p *casePlayer) accept() {
	for {
		conn, err := p.listener.Accept()
		if err != nil {
			p.mu.Lock()
			if !p.closing {
				p.failLocked(fmt.Sprintf("accept: %v", err))
			}
			p.mu.Unlock()
			return
		}
		done := make(chan struct{})
		p.mu.Lock()
		prior := append([]chan struct{}(nil), p.done...)
		p.done = append(p.done, done)
		p.connections++
		p.open[conn] = true
		p.mu.Unlock()
		go p.serve(conn, prior, done)
	}
}

// serve plays one connection: it sends the host frames that precede the next send step, checks each frame of the client and sends the
// frames that follow it.
func (p *casePlayer) serve(conn net.Conn, prior []chan struct{}, done chan struct{}) {
	defer close(done)
	defer p.release(conn)
	for _, previous := range prior {
		select {
		case <-previous:
		case <-time.After(casePlayerLimit):
			p.fail("a connection that preceded this one did not end")
			return
		}
	}
	frames, closedByHost, err := p.hostFrames()
	if err != nil {
		p.fail(err.Error())
		return
	}
	if p.deliver(conn, frames) != nil || closedByHost {
		return
	}
	for {
		body, err := readCaseFrame(conn)
		if err != nil {
			if errors.Is(err, errCaseFrameLength) {
				p.fail(fmt.Sprintf("the client sent an invalid frame: %v", err))
				return
			}
			p.connectionEnded()
			return
		}
		var message any
		if err := json.Unmarshal(body, &message); err != nil {
			p.fail(fmt.Sprintf("the client sent an invalid frame: %v", err))
			return
		}
		frames, closedByHost, ok := p.receive(message)
		if !ok {
			return
		}
		if p.deliver(conn, frames) != nil || closedByHost {
			return
		}
	}
}

var errCaseFrameLength = errors.New("frame length exceeds the limit")

// readCaseFrame reads one frame: a 4-byte big-endian length and a UTF-8 JSON body.
func readCaseFrame(conn net.Conn) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length > maxCaseFrame {
		return nil, fmt.Errorf("%w: %d > %d", errCaseFrameLength, length, maxCaseFrame)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(conn, body); err != nil {
		return nil, err
	}
	return body, nil
}

// deliver writes the frames to conn in order.
func (p *casePlayer) deliver(conn net.Conn, frames [][]byte) error {
	for _, body := range frames {
		frame := make([]byte, 4+len(body))
		binary.BigEndian.PutUint32(frame, uint32(len(body)))
		copy(frame[4:], body)
		if _, err := conn.Write(frame); err != nil {
			p.fail(fmt.Sprintf("writing a host frame: %v", err))
			return err
		}
	}
	return nil
}

// hostFrames returns the host frames that follow the cursor up to the next send step, encoded with the variables bound. It reports
// whether the host closes the connection after them.
func (p *casePlayer) hostFrames() ([][]byte, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.hostFramesLocked()
}

// bind replaces each variable with the text that the test gave it, or with its example.
func (p *casePlayer) bind(value any) any {
	switch v := value.(type) {
	case string:
		if match := caseVariablePattern.FindStringSubmatch(v); match != nil {
			if text, given := p.texts[match[1]]; given {
				return text
			}
			return p.variables[match[1]]
		}
	case []any:
		items := make([]any, len(v))
		for n, item := range v {
			items[n] = p.bind(item)
		}
		return items
	case *orderedObject:
		bound := &orderedObject{keys: v.keys, values: make(map[string]any, len(v.values))}
		for _, key := range v.keys {
			bound.values[key] = p.bind(v.values[key])
		}
		return bound
	}
	return value
}

// receive checks a frame of the client against the next step, which must be a send step with the same frame. It returns the host frames
// that follow the step; ok is false when the frame differs, and the connection ends.
func (p *casePlayer) receive(message any) ([][]byte, bool, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	request, isObject := message.(map[string]any)
	if isObject {
		p.requests = append(p.requests, request)
	}
	if p.cursor >= len(p.steps) || p.steps[p.cursor].kind != "send" {
		want := "no further step"
		if p.cursor < len(p.steps) {
			want = p.steps[p.cursor].text
		}
		p.failLocked(fmt.Sprintf("the client sent %v where the case has %s", message, want))
		return nil, false, false
	}
	step := p.steps[p.cursor]
	if !isObject || !reflect.DeepEqual(message, step.expected) {
		p.failLocked(fmt.Sprintf("step %d: the client sent %v, the case expects %s", p.cursor, message, step.text))
		return nil, false, false
	}
	p.cursor++
	frames, closedByHost, err := p.hostFramesLocked()
	if err != nil {
		p.failLocked(err.Error())
		return nil, false, false
	}
	return frames, closedByHost, true
}

// hostFramesLocked is hostFrames for a caller that holds p.mu.
func (p *casePlayer) hostFramesLocked() ([][]byte, bool, error) {
	var frames [][]byte
	for p.cursor < len(p.steps) && p.steps[p.cursor].kind != "send" {
		step := p.steps[p.cursor]
		switch step.kind {
		case "reply", "notify":
			var buffer bytes.Buffer
			if err := writeValue(&buffer, p.bind(step.value)); err != nil {
				return nil, false, err
			}
			frames = append(frames, buffer.Bytes())
		case "close":
			if step.closer == "client" {
				return frames, false, nil
			}
			p.cursor++
			return frames, true, nil
		}
		p.cursor++
	}
	return frames, false, nil
}

// connectionEnded handles the end of a connection that the client closed. A close step of the client is played by the end; any other
// end before the next step is a failure.
func (p *casePlayer) connectionEnded() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closing || p.cursor >= len(p.steps) {
		return
	}
	if p.steps[p.cursor].kind == "close" && p.steps[p.cursor].closer == "client" {
		p.cursor++
		return
	}
	p.failLocked(fmt.Sprintf("the client closed the connection before step %d: %s", p.cursor, p.steps[p.cursor].text))
}

// release forgets a connection and closes it.
func (p *casePlayer) release(conn net.Conn) {
	p.mu.Lock()
	delete(p.open, conn)
	p.mu.Unlock()
	conn.Close()
}

func (p *casePlayer) fail(message string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.failLocked(message)
}

func (p *casePlayer) failLocked(message string) {
	p.failures = append(p.failures, fmt.Sprintf("%s: %s", p.name, message))
}

// close ends the player. When the next step is a close step of the client, close waits for that close first. It removes the socket and
// returns every failure of the case, and a step that was not played.
func (p *casePlayer) close() error {
	p.mu.Lock()
	waitForClient := p.cursor < len(p.steps) && p.steps[p.cursor].kind == "close" && p.steps[p.cursor].closer == "client"
	done := append([]chan struct{}(nil), p.done...)
	p.mu.Unlock()
	if waitForClient {
		for _, ended := range done {
			select {
			case <-ended:
			case <-time.After(casePlayerLimit):
				p.fail("the client did not close its connection")
			}
		}
	}
	p.mu.Lock()
	p.closing = true
	open := make([]net.Conn, 0, len(p.open))
	for conn := range p.open {
		open = append(open, conn)
	}
	p.mu.Unlock()
	p.listener.Close()
	for _, conn := range open {
		conn.Close()
	}
	for _, ended := range done {
		select {
		case <-ended:
		case <-time.After(casePlayerLimit):
			p.fail("a connection did not end after the player closed it")
		}
	}
	os.RemoveAll(p.socketDir)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cursor < len(p.steps) {
		p.failLocked(fmt.Sprintf("%d steps were not played; the next step is %s", len(p.steps)-p.cursor, p.steps[p.cursor].text))
	}
	if len(p.failures) > 0 {
		return errors.New(strings.Join(p.failures, "\n"))
	}
	return nil
}

// methods returns the methods of the frames that the client sent, in order.
func (p *casePlayer) methods() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	methods := []string{}
	for _, request := range p.requests {
		method, _ := request["method"].(string)
		methods = append(methods, method)
	}
	return methods
}

// last returns the params of the last frame that the client sent.
func (p *casePlayer) last() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	params, _ := p.requests[len(p.requests)-1]["params"].(map[string]any)
	return params
}

// frames returns the frames that the client sent, in order.
func (p *casePlayer) frames() []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]map[string]any(nil), p.requests...)
}

// connectionCount returns the number of connections that the client opened.
func (p *casePlayer) connectionCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.connections
}
