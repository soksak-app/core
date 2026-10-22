// The JSON-RPC server of the local endpoint.
//
// The forms are defined in docs/spec/endpoint.md and docs/spec/exposure.md. The transport is the listener that the operating system implementation
// creates, and this file handles frame decoding, method dispatch, per-connection watches and notifications, and endpoint.json.
// Windows and pages are reached through Backend, so a check runs this server without the application.

package host

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
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// The maximum length of a frame body.
const frameLimit = 16 << 20

// Error numbers. They equal the error table of docs/spec/exposure.md.
const (
	codeInternal      = -32603
	codeInvalidParams = -32602
	codeHandler       = -32000
	codeUnknownName   = 1001
	codeUnregistered  = 1002
	codeNoWindow      = 1003
	codeNoInput       = 1004
	codeTimeout       = 1005
	codeInactive      = 1006
	codeButtonHeld    = 1007
	codePressOpen     = 1008
)

// RPCError is the JSON-RPC error object.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("%d: %s", e.Code, e.Message) }

func rpcError(code int, format string, args ...any) *RPCError {
	return &RPCError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// errMissingWindow creates the error for a missing window.
func errMissingWindow(window string) *RPCError {
	return rpcError(codeNoWindow, "window %q does not exist", window)
}

// WindowEntry is an item of windows.list.
type WindowEntry struct {
	Window string `json:"window"`
	Title  string `json:"title"`
	// Project is the root directory of the project that was opened last in the window. It is null when there is none.
	Project *string `json:"project"`
	Key     bool    `json:"key"`
	// Ready tells whether the main page of the window reported that it is ready. It is false while the page is read again.
	Ready bool `json:"ready"`
}

// PointerInput is the value of input.pointer. Phase is one of move, down, drag, up, and scroll, and
// Button is left or right. Activate can be true only for move.
type PointerInput struct {
	X, Y           float64
	Phase          string
	Button         string
	DeltaX, DeltaY float64
	Activate       bool
}

// KeyInput is the value of input.key. Modifiers is a bit sum: 1 Shift, 2 Control, 4 Option, 8 Command.
type KeyInput struct {
	Key       string
	Text      string
	Modifiers uint
	Down      bool
}

// Backend is the windows and pages that the endpoint uses. When the error is an *RPCError, the reply uses its number.
type Backend interface {
	// Windows is the list of open windows.
	Windows() []WindowEntry
	// HasWindow returns whether the window window exists.
	HasWindow(window string) bool
	// PageRequest sends a request to the main page of the window window and waits for its reply.
	PageRequest(window, method string, params json.RawMessage) (json.RawMessage, error)
	// HostStatus is the value of the host status name.
	HostStatus(window, name string) (any, error)
	// HostCommand runs the host command name.
	HostCommand(window, name string, params json.RawMessage) (any, error)
	// Pointer and Key deliver native input to a window.
	Pointer(window string, input PointerInput) error
	Key(window string, input KeyInput) error
}

// SocketDirectory is the directory in which the application places its socket. It is under the temporary directory of the user.
func SocketDirectory() string { return filepath.Join(os.TempDir(), "soksak") }

// EndpointInfo is the content of endpoint.json.
type EndpointInfo struct {
	Transport   string    `json:"transport"`
	Address     string    `json:"address"`
	PID         int       `json:"pid"`
	Application string    `json:"application"`
	Version     string    `json:"version"`
	Executable  string    `json:"executable"`
	Started     time.Time `json:"started"`
}

// endpointMethod is the handling of one declared method.
type endpointMethod func(e *Endpoint, c *endpointConn, params json.RawMessage) (any, error)

// diagnosticMethods are the methods that a diagnostic build adds in init. It is empty when the build is not a diagnostic build.
var diagnosticMethods = map[string]endpointMethod{}

// subscriptionMethod reads the params of a method that changes the subscription of a connection and returns the topic and the direction to change.
// These methods are applied in the order received.
type subscriptionMethod func(e *Endpoint, params json.RawMessage) (topic, bool, error)

var subscriptionMethods = map[string]subscriptionMethod{
	"status.watch":   func(e *Endpoint, p json.RawMessage) (topic, bool, error) { return watchTopic(e, p, true) },
	"status.unwatch": func(e *Endpoint, p json.RawMessage) (topic, bool, error) { return watchTopic(e, p, false) },
}

// diagnosticSubscriptions are the subscription methods that a diagnostic build adds in init.
var diagnosticSubscriptions = map[string]subscriptionMethod{}

// topic is the target that receives notifications. A status watch uses the status name and a diagnostic subscription uses a name of diagnosticTopics.
type topic struct {
	window string
	name   string
	// surface is the surface that the watch specified. A watch that did not specify one has an empty string.
	surface string
}

// watchParams are the params of the watch request to send to the page.
func (t topic) watchParams() map[string]string {
	params := map[string]string{"name": t.name}
	if t.surface != "" {
		params["surface"] = t.surface
	}
	return params
}

// diagnosticTopics are the subscription targets that a diagnostic build adds in init. A value builds the method and params of the request that
// tells the page about the start (on) and the end of a subscription. It is empty when the build is not a diagnostic build.
var diagnosticTopics = map[string]func(on bool) (method string, params any){}

// transcribe sends one line to a connection that enabled the diagnostic transcript of a window. A diagnostic build sets it in init.
var transcribe func(e *Endpoint, window, line string)

// Endpoint accepts connections and handles requests.
type Endpoint struct {
	backend Backend
	// The configuration directory. The switch and the target of the performance trace are here (V5-104).
	configDir string

	mu          sync.Mutex
	listener    net.Listener
	processLock *processLock
	// unrecordedEnd is the earlier run that left process.lock, or nil.
	unrecordedEnd *UnrecordedEnd
	file          string
	owner         EndpointInfo
	published     bool
	conns         map[*endpointConn]bool
	// counts is the number of subscribed connections for each topic.
	counts map[topic]int
	// queues are the subscription changes to run in the order received for each topic. When a list exists, a goroutine that runs
	// that topic exists. queueMu protects it.
	queueMu sync.Mutex
	queues  map[topic][]func()
}

// LockOwner is the owner that process.lock holds: the process identifier and the boot identifier of its host run
// (docs/spec/endpoint.md#discovery). A file of another form is refused.
type LockOwner struct {
	PID  int    `json:"pid"`
	Boot string `json:"boot"`
}

// lockAttempts is how many times the acquisition opens the lock file again after the file that it opened was replaced.
const lockAttempts = 8

// processLock gives one application process exclusive ownership of the configuration directory. The lock file stays open and locked with
// an exclusive advisory lock (flock) for the life of the process. A held lock means a live owner. A file that is present and not locked was
// left by an owner that ended without removing it, and the next owner takes it over. The lock is taken on the open file, so two starters that
// open the same file cannot both replace it.
type processLock struct {
	path string
	file *os.File
	// unrecordedEnd is the earlier run that left the file, when the file was present and not locked.
	unrecordedEnd *UnrecordedEnd
}

// parseOwner reads the owner that the contents of a lock file name: one JSON object with a positive pid and a non-empty boot.
func parseOwner(contents []byte) (LockOwner, bool) {
	var owner LockOwner
	decoder := json.NewDecoder(strings.NewReader(string(contents)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&owner); err != nil {
		return LockOwner{}, false
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return LockOwner{}, false
	}
	return owner, owner.PID > 0 && owner.Boot != ""
}

// openProcessLockFile creates the lock file at path, or opens the file that exists, and reports whether the file existed.
func openProcessLockFile(system platform.Platform, path string) (*os.File, bool, error) {
	file, err := system.CreatePrivateFile(path)
	if err == nil {
		return file, false, nil
	}
	if !errors.Is(err, os.ErrExist) {
		return nil, false, err
	}
	file, err = system.OpenPrivateFile(path)
	return file, true, err
}

// UnrecordedEnd is the earlier run that left process.lock without removing it. The file of the current form names the run by its boot and pid.
// Another content is reported as it was written, cut to 256 bytes, and Boot and PID are nil.
type UnrecordedEnd struct {
	Boot     *string
	PID      *int
	Previous *string
}

// reportedContentBytes is the number of bytes of a lock content that a refusal or an unrecorded end reports.
const reportedContentBytes = 256

// reportedContent is the first bytes of a lock content for a report, with an invalid sequence replaced.
func reportedContent(contents []byte) string {
	return strings.ToValidUTF8(string(contents[:min(len(contents), reportedContentBytes)]), "\uFFFD")
}

// unrecordedEndOf is the earlier run that a free lock file with these contents left.
func unrecordedEndOf(contents []byte) UnrecordedEnd {
	if owner, ok := parseOwner(contents); ok {
		boot, pid := owner.Boot, owner.PID
		return UnrecordedEnd{Boot: &boot, PID: &pid}
	}
	previous := reportedContent(contents)
	return UnrecordedEnd{Previous: &previous}
}

// heldRefusal is the refusal of a second start while the lock is held. The owner is live, so the refusal does not depend on the content:
// the content names the owner when it is the current form, and it is reported otherwise.
func heldRefusal(directory string, contents []byte) error {
	if owner, ok := parseOwner(contents); ok {
		return fmt.Errorf("configuration directory %s is already owned by process %d", directory, owner.PID)
	}
	if len(bytes.TrimSpace(contents)) == 0 {
		return fmt.Errorf("configuration directory %s is already owned by a live process", directory)
	}
	return fmt.Errorf("configuration directory %s is already owned by a live process; process.lock is not the current form: %s", directory, reportedContent(contents))
}

func acquireProcessLock(directory string) (*processLock, error) {
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	if err := system.CreatePrivateDirectories(directory); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, "process.lock")
	for attempt := 0; attempt < lockAttempts; attempt++ {
		file, existed, err := openProcessLockFile(system, path)
		// The file was removed after the create failed, so the next attempt creates it.
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		locked, err := system.TryLockFile(file)
		if err != nil {
			return nil, errors.Join(err, file.Close())
		}
		if !locked {
			// The owner removes the file before it unlocks, so a file that is gone now was released.
			contents, readErr := os.ReadFile(path)
			if errors.Is(readErr, os.ErrNotExist) {
				if err := file.Close(); err != nil {
					return nil, err
				}
				continue
			}
			if readErr != nil {
				return nil, errors.Join(readErr, file.Close())
			}
			return nil, errors.Join(heldRefusal(directory, contents), file.Close())
		}
		// The file at path was replaced after this open, so the lock is on a file that no longer names the lock.
		named, err := system.IsNamedFile(file, path)
		if err != nil {
			return nil, errors.Join(err, file.Close())
		}
		if !named {
			if err := file.Close(); err != nil {
				return nil, err
			}
			continue
		}
		// A free lock file that was present was left by an owner that ended without removing it, whatever its content, except
		// an empty file: a starter creates the file before it locks it, so an empty file that is free can belong to a starter
		// that has not locked it yet. No owner writes a record into an empty file, so it names no earlier run.
		var unrecordedEnd *UnrecordedEnd
		if existed {
			// The contents are read through the locked file, so they cannot change while they are checked.
			contents, err := io.ReadAll(file)
			if err != nil {
				return nil, errors.Join(err, file.Close())
			}
			if len(contents) > 0 {
				end := unrecordedEndOf(contents)
				unrecordedEnd = &end
			}
			if hook := processLockHook.Load(); hook != nil && *hook != nil {
				(*hook)(directory)
			}
		}
		if err := file.Truncate(0); err != nil {
			return nil, errors.Join(err, file.Close())
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return nil, errors.Join(err, file.Close())
		}
		owner, err := json.Marshal(LockOwner{PID: os.Getpid(), Boot: processBoot()})
		if err != nil {
			return nil, errors.Join(err, file.Close())
		}
		if _, err := file.Write(owner); err != nil {
			return nil, errors.Join(err, file.Close())
		}
		if err := file.Sync(); err != nil {
			return nil, errors.Join(err, file.Close())
		}
		return &processLock{path: path, file: file, unrecordedEnd: unrecordedEnd}, nil
	}
	return nil, fmt.Errorf("the process lock %s was replaced in each of %d attempts", path, lockAttempts)
}

// close removes the lock file while the lock is held, then closes the file, which releases the lock.
func (lock *processLock) close() error {
	if lock == nil {
		return nil
	}
	var errs []error
	if err := os.Remove(lock.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		errs = append(errs, err)
	}
	if err := lock.file.Close(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// NewEndpoint creates an endpoint that uses backend.
func NewEndpoint(backend Backend) *Endpoint {
	return &Endpoint{backend: backend, conns: map[*endpointConn]bool{}, counts: map[topic]int{}, queues: map[topic][]func(){}}
}

// Serve obtains the ownership of configDir and starts accepting connections of listener. Publish writes endpoint.json
// after the first window is registered.
func (e *Endpoint) Serve(listener net.Listener, info EndpointInfo, configDir string) error {
	e.configDir = configDir

	lock, err := acquireProcessLock(configDir)
	if err != nil {
		return err
	}
	file := filepath.Join(configDir, "endpoint.json")
	info.Started = info.Started.UTC().Truncate(time.Second)
	executable, err := os.Executable()
	if err != nil {
		return errors.Join(err, lock.close())
	}
	if info.Executable, err = filepath.EvalSymlinks(executable); err != nil {
		return errors.Join(err, lock.close())
	}
	e.mu.Lock()
	e.listener, e.processLock, e.file, e.owner = listener, lock, file, info
	e.unrecordedEnd = lock.unrecordedEnd
	e.mu.Unlock()
	routine.Go("endpoint-accept", func() { e.accept(listener) })
	return nil
}

// UnrecordedEnd returns the earlier run that left process.lock without removing it. ReportUnrecordedEnd stores it in the event
// host.run.unrecorded-end.
func (e *Endpoint) UnrecordedEnd() (UnrecordedEnd, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.unrecordedEnd == nil {
		return UnrecordedEnd{}, false
	}
	return *e.unrecordedEnd, true
}

// ReportUnrecordedEnd stores the event host.run.unrecorded-end at the level error. The field boot and pid are null when the lock is not
// the current form, and previous holds the content of the lock when it is not the current form.
func ReportUnrecordedEnd(end UnrecordedEnd) {
	fields := map[string]any{"boot": nil, "pid": nil}
	if end.Boot != nil {
		fields["boot"] = *end.Boot
	}
	if end.PID != nil {
		fields["pid"] = *end.PID
	}
	if end.Previous != nil {
		fields["previous"] = *end.Previous
	}
	EmitHost(LevelError, "host.run.unrecorded-end", fields)
}

// Publish writes endpoint.json when the window window is registered. It is called once after the first window is registered so that
// a client that read the file can request that window immediately.
func (e *Endpoint) Publish(window string) error {
	if !e.backend.HasWindow(window) {
		return fmt.Errorf("endpoint.json is not written: window %s does not exist", window)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case e.file == "":
		return errors.New("the endpoint is not serving")
	case e.published:
		return errors.New("endpoint.json is already written")
	}
	if err := writeJSON(e.file, e.owner); err != nil {
		return err
	}
	e.published = true
	return nil
}

// Close stops accepting connections, closes the open connections, and removes endpoint.json.
func (e *Endpoint) Close() error {
	e.mu.Lock()
	listener, processLock, file, owner := e.listener, e.processLock, e.file, e.owner
	e.listener, e.processLock, e.file, e.owner, e.published = nil, nil, "", EndpointInfo{}, false
	conns := make([]*endpointConn, 0, len(e.conns))
	for c := range e.conns {
		conns = append(conns, c)
	}
	e.mu.Unlock()
	var errs []error
	if listener != nil {
		errs = append(errs, listener.Close())
	}
	for _, c := range conns {
		c.close("the endpoint closed")
	}
	if file != "" {
		var current EndpointInfo
		data, err := os.ReadFile(file)
		switch {
		case errors.Is(err, os.ErrNotExist):
		case err != nil:
			errs = append(errs, err)
		case json.Unmarshal(data, &current) != nil:
			errs = append(errs, fmt.Errorf("endpoint file %s is not valid JSON", file))
		case current.PID == owner.PID && current.Address == owner.Address &&
			current.Application == owner.Application && current.Started.Equal(owner.Started) &&
			current.Executable == owner.Executable:
			if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
				errs = append(errs, err)
			}
		}
	}
	if err := processLock.close(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (e *Endpoint) accept(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			// Close clears e.listener before it closes the listener, so an accept that fails after Close is the end of serving and is not an error.
			if e.serving(listener) {
				LogError("endpoint accept", err)
			}
			return
		}
		c := &endpointConn{conn: conn, topics: map[topic]bool{}, out: make(chan []byte, EndpointOutputFrames), done: make(chan struct{})}
		e.mu.Lock()
		e.conns[c] = true
		e.mu.Unlock()
		routine.Go("endpoint-write", c.write)
		routine.Go("endpoint-read", func() { e.read(c) })
	}
}

// serving reports whether listener is the listener that the endpoint serves.
func (e *Endpoint) serving(listener net.Listener) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.listener == listener
}

// StatusChanged announces the new value to the connections that watch the status name of the window window. surface is the surface that the watch
// specified, and it is an empty string for a change of a watch that did not specify one.
func (e *Endpoint) StatusChanged(window, name, surface string, value any) {
	params := map[string]any{"window": window, "name": name, "value": value}
	if surface != "" {
		params["surface"] = surface
	}
	e.publish(topic{window, name, surface}, "status.changed", params)
}

// NotifyWatchers announces the new value of the status name, which is not bound to a window, for each window to the connections that watch it without specifying a surface.
// The notifications enter the send queue of each connection in the order of the calls and do not block the caller.
func (e *Endpoint) NotifyWatchers(name string, value any) {
	e.mu.Lock()
	windows := make([]string, 0)
	for t, count := range e.counts {
		if t.name == name && t.surface == "" && count > 0 {
			windows = append(windows, t.window)
		}
	}
	e.mu.Unlock()
	sort.Strings(windows)
	for _, window := range windows {
		e.StatusChanged(window, name, "", value)
	}
}

// Watching returns whether a connection watches the status name of the window window.
func (e *Endpoint) Watching(window, name string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.counts[topic{window, name, ""}] > 0
}

func (e *Endpoint) publish(t topic, method string, params any) {
	data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	if err != nil {
		LogError("endpoint notification", err)
		return
	}
	e.mu.Lock()
	targets := make([]*endpointConn, 0)
	for c := range e.conns {
		if c.topics[t] {
			targets = append(targets, c)
		}
	}
	e.mu.Unlock()
	for _, c := range targets {
		c.send(data)
	}
}

// subscribe changes the topic subscription of connection c and returns whether the change is the first subscription or the last release.
func (e *Endpoint) subscribe(c *endpointConn, t topic, on bool) (edge bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if c.topics[t] == on {
		return false
	}
	if on {
		c.topics[t] = true
		e.counts[t]++
		return e.counts[t] == 1
	}
	delete(c.topics, t)
	e.counts[t]--
	if e.counts[t] > 0 {
		return false
	}
	delete(e.counts, t)
	return true
}

// topics are the topics for which the page of the window window must send notifications. When the page is loaded again, the host
// requests the watches again with this list.
func (e *Endpoint) topics(window string) []topic {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []topic
	for t := range e.counts {
		if t.window == window {
			out = append(out, t)
		}
	}
	return out
}

// endpointConn is one connection and its subscriptions. topics is protected by Endpoint.mu.
type endpointConn struct {
	conn   net.Conn
	topics map[topic]bool
	out    chan []byte
	// queued is the number of bytes of the frames in out and in the write that is in progress.
	queued atomic.Int64
	done   chan struct{}
	once   sync.Once
}

// close closes the connection. It records the reason reason of the first closer before it closes the socket, and later calls do nothing.
func (c *endpointConn) close(reason string) {
	c.once.Do(func() {
		LogInfo("endpoint", "connection closed: "+reason)
		close(c.done)
		if err := c.conn.Close(); err != nil {
			LogError("endpoint connection close", err)
		}
	})
}

// send puts one frame into the write queue. The queue holds at most EndpointOutputFrames frames and EndpointOutputBytes
// bytes. When the queue is full, the connection does not read, so the frame is refused, the refusal is the event
// `host.buffer.dropped`, and the connection is closed.
func (c *endpointConn) send(body []byte) {
	size := int64(len(body))
	if c.queued.Add(size) > EndpointOutputBytes {
		c.queued.Add(-size)
		c.refuse(len(body), fmt.Sprintf("%d bytes", EndpointOutputBytes))
		return
	}
	select {
	case c.out <- body:
	case <-c.done:
		c.queued.Add(-size)
	default:
		c.queued.Add(-size)
		c.refuse(len(body), fmt.Sprintf("%d messages", EndpointOutputFrames))
	}
}

// refuse records the frame that the full write queue refused and closes the connection, which does not read.
func (c *endpointConn) refuse(bytes int, limit string) {
	recordBufferDrop("endpoint output queue", bytes, limit)
	LogError("endpoint", "closing a connection that does not read")
	c.close("the output queue is full")
}

func (c *endpointConn) write() {
	for {
		select {
		case <-c.done:
			return
		case body := <-c.out:
			c.queued.Add(-int64(len(body)))
			frame := binary.BigEndian.AppendUint32(make([]byte, 0, 4+len(body)), uint32(len(body)))
			if _, err := c.conn.Write(append(frame, body...)); err != nil {
				LogError("endpoint connection write", err)
				c.close("write failed")
				return
			}
		}
	}
}

// request is the received JSON-RPC object. A request without id is a notification, so it gets no reply.
type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  *string         `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// readReason is the close reason of a failed read. A connection that ends or resets at a frame boundary is a peer close. A frame
// that ends early has the reason truncated. Any other I/O error keeps its own text, as the Rust host does.
func readReason(err error, boundary bool, truncated string) string {
	if boundary && (errors.Is(err, io.EOF) || errors.Is(err, syscall.ECONNRESET)) {
		return "peer closed"
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return truncated
	}
	return err.Error()
}

// read reads the frames of the connection. When it receives a frame that breaks a rule, it does not reply but closes the connection and records the reason for closing.
func (e *Endpoint) read(c *endpointConn) {
	reason := "peer closed"
	defer func() { e.drop(c, reason) }()
	var size [4]byte
	for {
		if _, err := io.ReadFull(c.conn, size[:]); err != nil {
			reason = readReason(err, true, "connection closed inside a length prefix")
			return
		}
		length := binary.BigEndian.Uint32(size[:])
		if length > frameLimit {
			reason = fmt.Sprintf("frame of %d bytes exceeds the limit of %d", length, frameLimit)
			return
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(c.conn, body); err != nil {
			reason = readReason(err, false, "connection closed inside a frame body")
			return
		}
		var req request
		if !json.Valid(body) || json.Unmarshal(body, &req) != nil || req.JSONRPC != "2.0" || req.Method == nil {
			reason = "frame is not a JSON-RPC 2.0 request: " + string(body)
			return
		}
		if parse, ok := e.subscription(*req.Method); ok {
			e.changeInOrder(c, req, parse)
			continue
		}
		method, declared := e.method(*req.Method)
		if !declared {
			reason = fmt.Sprintf("method %q is not declared", *req.Method)
			return
		}
		routine.Go("endpoint-run", func() { e.run(c, req, method) })
	}
}

// subscription returns the handling of a declared method that changes a subscription.
func (e *Endpoint) subscription(name string) (subscriptionMethod, bool) {
	if parse, ok := subscriptionMethods[name]; ok {
		return parse, true
	}
	parse, ok := diagnosticSubscriptions[name]
	return parse, ok
}

// changeInOrder puts one subscription change request at the end of the queue of its topic. It is called from the read loop, so
// changes of the same topic and messages to the page run in the order received, and the reply is sent after the page replied.
func (e *Endpoint) changeInOrder(c *endpointConn, req request, parse subscriptionMethod) {
	started := time.Now()
	t, on, err := parse(e, req.Params)
	if err != nil {
		recordEndpointCall(req, started, err)
		routine.Go("endpoint-reply", func() { e.reply(c, req, nil, err) })
		return
	}
	if !e.enqueue(t, true, func() {
		err := e.change(c, t, on)
		recordEndpointCall(req, started, err)
		e.reply(c, req, nil, err)
	}) {
		// The page does not answer the changes of this topic as fast as the client sends them; the change is refused.
		refused := rpcError(codeHandler, "the subscription changes of %s are not keeping up: %d changes are pending, so this change is refused", t.name, EndpointTopicChanges)
		recordBufferDrop("endpoint topic changes", len(req.Params), fmt.Sprintf("%d messages", EndpointTopicChanges))
		recordEndpointCall(req, started, refused)
		routine.Go("endpoint-reply", func() { e.reply(c, req, nil, refused) })
	}
}

// change changes the topic subscription of connection c and, for the first subscription or the last release, notifies the page. When the page
// rejects the first subscription, the subscription is reverted.
func (e *Endpoint) change(c *endpointConn, t topic, on bool) error {
	if !e.subscribe(c, t, on) {
		return nil
	}
	err := e.notifyPage(t, on)
	if err != nil && on {
		e.subscribe(c, t, false)
	}
	return err
}

// enqueue puts job into the queue of topic t and starts a goroutine when none is running. A bounded job is refused, and
// enqueue returns false, when EndpointTopicChanges jobs wait already; the release of the subscriptions of a closed
// connection is not bounded, because the number of its jobs is the number of topics the connection held.
func (e *Endpoint) enqueue(t topic, bounded bool, job func()) bool {
	e.queueMu.Lock()
	defer e.queueMu.Unlock()
	pending, running := e.queues[t]
	if bounded && len(pending) >= EndpointTopicChanges {
		return false
	}
	e.queues[t] = append(pending, job)
	if !running {
		routine.Go("endpoint-drain", func() { e.drain(t) })
	}
	return true
}

// drain runs the jobs in order until the queue of topic t is empty.
func (e *Endpoint) drain(t topic) {
	for {
		e.queueMu.Lock()
		pending := e.queues[t]
		if len(pending) == 0 {
			delete(e.queues, t)
			e.queueMu.Unlock()
			return
		}
		job := pending[0]
		e.queues[t] = pending[1:]
		e.queueMu.Unlock()
		job()
	}
}

// drop removes a closed connection from the list and releases its subscriptions. For the state in which the last watch disappeared, it sends
// the release to the page. When no one closed the connection first, reason is the reason for closing.
func (e *Endpoint) drop(c *endpointConn, reason string) {
	c.close(reason)
	e.mu.Lock()
	delete(e.conns, c)
	held := make([]topic, 0, len(c.topics))
	for t := range c.topics {
		held = append(held, t)
	}
	e.mu.Unlock()
	for _, t := range held {
		e.enqueue(t, false, func() {
			if err := e.change(c, t, false); err != nil {
				LogError("endpoint release", fmt.Sprintf("%s on %s: %v", t.name, t.window, err))
			}
		})
	}
}

// notifyPage sends the first subscription or the last release of a topic to the page. Host statuses are not sent to the page.
func (e *Endpoint) notifyPage(t topic, on bool) error {
	var err error
	request, diagnostic := diagnosticTopics[t.name]
	switch {
	case diagnostic:
		method, params := request(on)
		_, err = e.backend.PageRequest(t.window, method, mustJSON(params))
	case isHostName(t.name):
	case on:
		_, err = e.backend.PageRequest(t.window, "status.watch", mustJSON(t.watchParams()))
	default:
		_, err = e.backend.PageRequest(t.window, "status.unwatch", mustJSON(t.watchParams()))
	}
	return err
}

func (e *Endpoint) run(c *endpointConn, req request, method endpointMethod) {
	// The name, the arguments, the result and the time of every endpoint method are the event host.endpoint.call.
	started := time.Now()
	result, err := method(e, c, req.Params)
	recordEndpointCall(req, started, err)
	// A timeout is an error that the requester receives, but only this record keeps which method and what the request waited for.
	var coded *RPCError
	if errors.As(err, &coded) && coded.Code == codeTimeout {
		LogError("endpoint timeout", fmt.Sprintf("%s: %s", methodOf(req), coded.Message))
	}
	e.reply(c, req, result, err)
}

// reply sends the result or the error of the request req. It does not reply to a request without id.
func (e *Endpoint) reply(c *endpointConn, req request, result any, err error) {
	if len(req.ID) == 0 || string(req.ID) == "null" {
		return
	}
	reply := map[string]any{"jsonrpc": "2.0", "id": req.ID}
	if err != nil {
		var coded *RPCError
		if !errors.As(err, &coded) {
			coded = rpcError(codeInternal, "%v", err)
		}
		reply["error"] = coded
	} else {
		reply["result"] = result
	}
	data, marshalErr := json.Marshal(reply)
	if marshalErr != nil {
		LogError("endpoint reply", fmt.Sprintf("cannot encode the reply for %s: %v", req.ID, marshalErr))
		c.close("the reply cannot be encoded")
		return
	}
	c.send(data)
}

func mustJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

// method returns the handling of a declared method.
func (e *Endpoint) method(name string) (endpointMethod, bool) {
	if method, ok := endpointMethods[name]; ok {
		return method, true
	}
	method, ok := diagnosticMethods[name]
	return method, ok
}

var endpointMethods = map[string]endpointMethod{
	"windows.list":  func(e *Endpoint, _ *endpointConn, _ json.RawMessage) (any, error) { return e.backend.Windows(), nil },
	"log.query":     logQuery,
	"exposure.list": exposureList,
	"status.get":    statusGet,
	"command.run":   commandRun,
	"dom.rect":      domRequest("dom.rect"),
	"dom.act":       domRequest("dom.act"),
	"input.pointer": inputPointer,
	"input.key":     inputKey,
}

// namePattern is the form of an entry name.
var namePattern = regexp.MustCompile(`^[a-z0-9-]+(\.[a-z0-9-]+)+$`)

func isHostName(name string) bool { return strings.HasPrefix(name, "host.") }

// target is the common parameter of a request that specifies a window.
type target struct {
	Window  *string `json:"window"`
	Name    *string `json:"name"`
	Surface *string `json:"surface"`
}

// decode reads params into into. It is a parameter error when params is not an object.
func decode(params json.RawMessage, into any) error {
	if len(params) == 0 || params[0] != '{' {
		return rpcError(codeInvalidParams, "params must be an object")
	}
	if err := json.Unmarshal(params, into); err != nil {
		return rpcError(codeInvalidParams, "%v", err)
	}
	return nil
}

// window reads the window of params and checks that the window exists.
func (e *Endpoint) window(params json.RawMessage) (string, error) {
	var t target
	if err := decode(params, &t); err != nil {
		return "", err
	}
	if t.Window == nil || *t.Window == "" {
		return "", rpcError(codeInvalidParams, "window is required")
	}
	if !e.backend.HasWindow(*t.Window) {
		return "", errMissingWindow(*t.Window)
	}
	return *t.Window, nil
}

// named reads the window and the name of params.
func (e *Endpoint) named(params json.RawMessage) (string, string, error) {
	var t target
	if err := decode(params, &t); err != nil {
		return "", "", err
	}
	if t.Name == nil || !namePattern.MatchString(*t.Name) {
		return "", "", rpcError(codeInvalidParams, "name is required and must have the form <owner>.<name>")
	}
	window, err := e.window(params)
	return window, *t.Name, err
}

// withoutWindow removes window from the params to send to the page.
func withoutWindow(params json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(params, &fields); err != nil {
		return params
	}
	delete(fields, "window")
	return mustJSON(fields)
}

func exposureList(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	reply, err := e.backend.PageRequest(window, "exposure.list", json.RawMessage(`{}`))
	if err != nil {
		return nil, err
	}
	var list map[string][]json.RawMessage
	if err := json.Unmarshal(reply, &list); err != nil {
		return nil, rpcError(codeInternal, "page exposure.list: %v", err)
	}
	// A JSON null is decoded as a nil map without an error, so it is rejected as a list that is not an object.
	if list == nil {
		return nil, rpcError(codeInternal, "page exposure.list is %s, not an object", reply)
	}
	for _, entry := range listedEntries(hostStatus, true) {
		list["status"] = append(list["status"], mustJSON(entry))
	}
	for _, entry := range listedEntries(hostCommands, false) {
		list["commands"] = append(list["commands"], mustJSON(entry))
	}
	if list["dom"] == nil {
		list["dom"] = []json.RawMessage{}
	}
	return list, nil
}

func statusGet(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, name, err := e.named(params)
	if err != nil {
		return nil, err
	}
	if isHostName(name) {
		if _, ok := hostStatus[name]; !ok {
			return nil, rpcError(codeUnknownName, "unknown status %s", name)
		}
		return e.backend.HostStatus(window, name)
	}
	return e.backend.PageRequest(window, "status.get", withoutWindow(params))
}

// watchTopic reads the topic to change from the params of status.watch and status.unwatch.
func watchTopic(e *Endpoint, params json.RawMessage, on bool) (topic, bool, error) {
	window, name, err := e.named(params)
	if err != nil {
		return topic{}, on, err
	}
	t := topic{window: window, name: name}
	if isHostName(name) {
		if _, ok := hostStatus[name]; !ok {
			return topic{}, on, rpcError(codeUnknownName, "unknown status %s", name)
		}
		return t, on, nil
	}
	var fields target
	if err := decode(params, &fields); err != nil {
		return topic{}, on, err
	}
	if fields.Surface != nil {
		if *fields.Surface == "" {
			return topic{}, on, rpcError(codeInvalidParams, "surface must not be empty")
		}
		t.surface = *fields.Surface
	}
	return t, on, nil
}

func commandRun(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, name, err := e.named(params)
	if err != nil {
		return nil, err
	}
	if isHostName(name) {
		if _, ok := hostCommands[name]; !ok {
			return nil, rpcError(codeUnknownName, "unknown command %s", name)
		}
		var fields struct {
			Params json.RawMessage `json:"params"`
		}
		if err := decode(params, &fields); err != nil {
			return nil, err
		}
		if len(fields.Params) == 0 || string(fields.Params) == "null" {
			fields.Params = json.RawMessage(`{}`)
		}
		if fields.Params[0] != '{' {
			return nil, rpcError(codeInvalidParams, "params of %s must be an object", name)
		}
		return e.backend.HostCommand(window, name, fields.Params)
	}
	return e.backend.PageRequest(window, "command.run", withoutWindow(params))
}

func domRequest(method string) endpointMethod {
	return func(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
		window, name, err := e.named(params)
		if err != nil {
			return nil, err
		}
		if isHostName(name) {
			return nil, rpcError(codeUnknownName, "the host declares no dom entry %s", name)
		}
		return e.backend.PageRequest(window, method, withoutWindow(params))
	}
}

var pointerPhases = map[string]bool{"move": true, "down": true, "drag": true, "up": true, "scroll": true}

func inputPointer(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	var p struct {
		X, Y           *float64
		Phase          string
		Button         *string
		DeltaX, DeltaY float64
		Activate       bool
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.X == nil || p.Y == nil {
		return nil, rpcError(codeInvalidParams, "x and y are required")
	}
	if !pointerPhases[p.Phase] {
		return nil, rpcError(codeInvalidParams, "phase must be move, down, drag, up, or scroll")
	}
	button := "left"
	if p.Button != nil {
		button = *p.Button
	}
	if button != "left" && button != "right" {
		return nil, rpcError(codeInvalidParams, "button must be left or right")
	}
	if p.Activate && p.Phase != "move" {
		return nil, rpcError(codeInvalidParams, "activate applies only to phase move")
	}
	return nil, e.backend.Pointer(window, PointerInput{X: *p.X, Y: *p.Y, Phase: p.Phase, Button: button,
		DeltaX: p.DeltaX, DeltaY: p.DeltaY, Activate: p.Activate})
}

// modifierBits are the modifiers names of input.key and the bits of the native input.
var modifierBits = map[string]uint{"shift": 1, "control": 2, "option": 4, "command": 8}

func inputKey(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	var k struct {
		Key       string
		Text      string
		Modifiers []string
		Phase     string
	}
	if err := decode(params, &k); err != nil {
		return nil, err
	}
	if k.Key == "" {
		return nil, rpcError(codeInvalidParams, "key is required")
	}
	if k.Phase != "down" && k.Phase != "up" {
		return nil, rpcError(codeInvalidParams, "phase must be down or up")
	}
	var mask uint
	for _, name := range k.Modifiers {
		bit, ok := modifierBits[name]
		if !ok {
			return nil, rpcError(codeInvalidParams, "modifier %q is not shift, control, option, or command", name)
		}
		mask |= bit
	}
	return nil, e.backend.Key(window, KeyInput{Key: k.Key, Text: k.Text, Modifiers: mask, Down: k.Phase == "down"})
}

// The method name of the request. A request without one has an empty string.
func methodOf(req request) string {
	if req.Method == nil {
		return ""
	}
	return *req.Method
}
