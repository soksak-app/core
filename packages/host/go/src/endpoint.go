// The JSON-RPC server of the local endpoint.
//
// The forms are defined in docs/spec/endpoint.md and docs/spec/exposure.md. The transport is the listener that the operating system implementation
// creates, and this file handles frame decoding, method dispatch, per-connection watches and notifications, and endpoint.json.
// Windows and pages are reached through Backend, so a check runs this server without the application.

package host

import (
	"bytes"
	"context"
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
	"unicode/utf16"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
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
	codePointerHeld   = 1011
)

// RPCError is the JSON-RPC error object.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// UnmarshalJSON reads an error member, which names its code and its message. A member without either is refused, so no code 0 or
// empty message stands for it.
func (e *RPCError) UnmarshalJSON(data []byte) error {
	var raw struct {
		Code    *int    `json:"code"`
		Message *string `json:"message"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw.Code == nil {
		return errors.New("error has no code")
	}
	if raw.Message == nil {
		return errors.New("error has no message")
	}
	e.Code, e.Message = *raw.Code, *raw.Message
	return nil
}

func (e *RPCError) Error() string { return fmt.Sprintf("%d: %s", e.Code, e.Message) }

func rpcError(code int, format string, args ...any) *RPCError {
	return &RPCError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// errMissingWindow creates the error for a missing window.
func errMissingWindow(window string) *RPCError {
	return rpcError(codeNoWindow, "window %q does not exist", window)
}

// WindowClosed reports whether err is the error of a window that closed before the read: a window that closed has nothing to
// read and no screen to show a failure.
func WindowClosed(err error) bool {
	var coded *RPCError
	return errors.As(err, &coded) && coded.Code == codeNoWindow
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

// PointerInput is the value of input.pointer. Pointer names the pointer, mainPointer when the request names none.
// Phase is one of move, down, drag, up, and scroll, and Button is left or right. Activate can be true only for move.
// Clicks is the click count of the event of a down or an up, from 1 to pointerClicksMax.
type PointerInput struct {
	Pointer        string
	X, Y           float64
	Phase          string
	Button         string
	DeltaX, DeltaY float64
	Activate       bool
	Clicks         int
}

// pointerClicksMax is the largest click count of input.pointer: a person's triple click.
const pointerClicksMax = 3

// mainPointer is the pointer of an input.pointer request that names none.
const mainPointer = "main"

// pointerNameMax is the longest pointer name: a name has 1 to pointerNameMax characters of a-z, 0-9 and -.
const pointerNameMax = 32

// pointerName reports whether name has the form of a pointer name.
func pointerName(name string) bool {
	if name == "" || len(name) > pointerNameMax {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// pointerFields names every field of input.pointer. A field outside it is rejected, so a misspelled or an
// unsupported field does not deliver a different gesture than the caller asked for.
var pointerFields = map[string]bool{"window": true, "pointer": true, "x": true, "y": true, "phase": true, "button": true,
	"deltaX": true, "deltaY": true, "activate": true, "clicks": true}

// KeyInput is the value of input.key. Modifiers is a bit sum: 1 Shift, 2 Control, 4 Option, 8 Command.
type KeyInput struct {
	Key       string
	Text      string
	Modifiers uint
	Down      bool
}

// The steps of a composition of input.text, as the input method of the system gives them to the text input client of the key
// responder.
const (
	TextMark   = 0
	TextInsert = 1
	TextUnmark = 2
)

// TextInput is one step of a composition (docs/spec/exposure.md#methods). Ranges count UTF-16 code units; ReplacementStart -1 is
// no range, which replaces the marked text or the selection.
type TextInput struct {
	Phase             int
	Text              string
	SelectionStart    int
	SelectionLength   int
	ReplacementStart  int
	ReplacementLength int
}

// Backend is the windows and pages that the endpoint uses. When the error is an *RPCError, the reply uses its number.
type Backend interface {
	// Windows is the list of open windows.
	Windows() []WindowEntry
	// HasWindow returns whether the window window exists.
	HasWindow(window string) bool
	// PageRequest sends a request to the main page of the window window and waits for its reply. The end of ctx, the end of the
	// endpoint connection that sent the request, ends the wait.
	PageRequest(ctx context.Context, window, method string, params json.RawMessage) (json.RawMessage, error)
	// HostStatus is the value of the host status name.
	HostStatus(window, name string) (any, error)
	// HostCommand runs the host command name.
	HostCommand(window, name string, params json.RawMessage, reply *ReplyScope) (any, error)
	// Pointer and Key deliver native input to a window.
	Pointer(window string, input PointerInput) error
	Key(window string, input KeyInput) error
	// Text gives one step of a composition to the text input client of the key responder of a window.
	Text(window string, input TextInput) error
	// HostWatched tells the host that the first watch of its status name in window started (on) or that the last one ended.
	HostWatched(window, name string, on bool)
	// DialogAnswer answers a dialog request of window (docs/spec/exposure.md#dialogs).
	DialogAnswer(window string, answer DialogAnswer) error
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
type endpointMethod func(e *Endpoint, c *endpointConn, params json.RawMessage, reply *ReplyScope) (any, error)

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
	// activity is whether the endpoint holds the connection activity of the platform (holdConnectionActivity).
	activity bool
	// counts is the number of subscribed connections for each topic.
	counts map[topic]int
	// queues are the subscription changes to run in the order received for each topic. When a list exists, a goroutine that runs
	// that topic exists. queueMu protects it.
	queueMu sync.Mutex
	queues  map[topic][]func()
	// presses are the open presses that delivered downs of the connections opened (releasePresses). pressMu protects them
	// and the pressesReleased mark of each connection.
	pressMu sync.Mutex
	presses map[pressKey]*openPress
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
		c := &endpointConn{conn: conn, topics: map[topic]bool{}, out: make(chan endpointFrame, EndpointOutputFrames), done: make(chan struct{})}
		e.mu.Lock()
		e.conns[c] = true
		if len(e.conns) == 1 {
			e.activity = holdConnectionActivity(true)
		}
		e.mu.Unlock()
		routine.Go("endpoint-write", c.write)
		routine.Go("endpoint-read", func() { e.read(c) })
	}
}

// holdConnectionActivity holds the activity of the process while a connection is open, so that the system does not run the host
// in the background while a client waits for its answers (docs/spec/endpoint.md#transport). The caller holds e.mu, so the
// requests follow the order of the changes of the connections. It reports whether the platform made the change.
func holdConnectionActivity(held bool) bool {
	current, err := platform.Current()
	if err == nil {
		err = current.HoldConnectionActivity(held)
	}
	if err != nil {
		LogError("endpoint activity", err)
		return false
	}
	return true
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
	// The release of a press of a closed connection that 1007 refused waits for this change (retryReleases). The caller
	// announces in its lock and must not block, so the release runs in its own routine.
	if name == "host.buttons" {
		routine.Go("endpoint-release", func() { e.buttonsChanged(value) })
	}
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
		c.send(data, "notification "+method)
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

// endpointFrame is one frame of the write queue and the name that records it when it is not sent: "reply to <id>" or
// "notification <method>". answer is the response completion of a reply, nil for a notification.
type endpointFrame struct {
	body   []byte
	name   string
	answer *replyAnswer
}

// ReplyOutcomeKind is the transport outcome of one endpoint response, apart from its command result.
type ReplyOutcomeKind int

const (
	// ReplyWritten: the whole response frame was written to the socket.
	ReplyWritten ReplyOutcomeKind = iota + 1
	// ReplyNoResponse: the request is a notification, which gets no response.
	ReplyNoResponse
	// ReplyWriteFailed: the response was not written; Error holds the reason.
	ReplyWriteFailed
	// ReplyAbandoned: the request ended without producing a response.
	ReplyAbandoned
)

// ReplyOutcome is the transport outcome of one endpoint response and, for a failed write, its reason.
type ReplyOutcome struct {
	Kind  ReplyOutcomeKind
	Error string
}

// ReplyScope is the response context of one endpoint request, for work that must follow the write attempt of that
// response, such as a normal quit (docs/spec/endpoint.md). Internal subscription maintenance has no scope.
type ReplyScope struct {
	// ctx ends when the endpoint connection of the request ends.
	ctx       context.Context
	mu        sync.Mutex
	done      bool
	outcome   ReplyOutcome
	callbacks []func(ReplyOutcome)
}

// Context ends when the endpoint connection that sent the request ends, so a wait of the request ends with its requester. A nil
// scope, or a scope that no connection sent, never ends.
func (s *ReplyScope) Context() context.Context {
	if s == nil || s.ctx == nil {
		return context.Background()
	}
	return s.ctx
}

// AfterResponse runs callback once after the response attempt of the request completes, outside the locks of the scope
// and of the connection writer. A callback registered after completion runs at once with the same outcome. A nil
// scope has no response, so callback runs at once with ReplyNoResponse.
func (s *ReplyScope) AfterResponse(callback func(ReplyOutcome)) {
	if s == nil {
		callback(ReplyOutcome{Kind: ReplyNoResponse})
		return
	}
	s.mu.Lock()
	if !s.done {
		s.callbacks = append(s.callbacks, callback)
		s.mu.Unlock()
		return
	}
	outcome := s.outcome
	s.mu.Unlock()
	callback(outcome)
}

// replyAnswer completes the scope of one request exactly once.
type replyAnswer struct {
	scope *ReplyScope
	once  sync.Once
}

// newReplyScope returns the scope of a request and the answer that completes it.
func newReplyScope() (*ReplyScope, *replyAnswer) {
	scope := &ReplyScope{}
	return scope, &replyAnswer{scope: scope}
}

// finish records outcome and runs the registered callbacks; later calls do nothing. A nil answer does nothing.
func (a *replyAnswer) finish(outcome ReplyOutcome) {
	if a == nil {
		return
	}
	a.once.Do(func() {
		a.scope.mu.Lock()
		a.scope.done, a.scope.outcome = true, outcome
		callbacks := a.scope.callbacks
		a.scope.callbacks = nil
		a.scope.mu.Unlock()
		for _, callback := range callbacks {
			callback(outcome)
		}
	})
}

// failed finishes the answer with a write that did not happen for reason.
func (a *replyAnswer) failed(reason string) {
	a.finish(ReplyOutcome{Kind: ReplyWriteFailed, Error: reason})
}

// Abandon finishes an answer whose request produced no response.
func (a *replyAnswer) Abandon() { a.finish(ReplyOutcome{Kind: ReplyAbandoned}) }

// endpointConn is one connection and its subscriptions. topics is protected by Endpoint.mu.
type endpointConn struct {
	conn   net.Conn
	topics map[topic]bool
	out    chan endpointFrame
	// queued is the number of bytes of the frames in out and in the write that is in progress.
	queued atomic.Int64
	done   chan struct{}
	once   sync.Once
	// reason is the reason of the first close, which a frame that is not sent afterwards names.
	reasonMu sync.Mutex
	reason   string
	// pressesReleased is set when the close of the connection released its presses; Endpoint.pressMu protects it.
	pressesReleased bool
	// ends are the callbacks that run when the connection closes, by their number; closed is set by the close. Both are
	// protected by reasonMu.
	ends    map[uint64]func()
	endNext uint64
	closed  bool
	// changes are the subscription changes of the connection that wait in the queue of each topic or run there, with the last of
	// them. Endpoint.queueMu protects it.
	changes map[topic]*topicChanges
}

// onClose runs end when the connection closes, before close returns, or at once when it is already closed. remove takes end
// back, so a request that ended without the close leaves nothing behind.
func (c *endpointConn) onClose(end func()) (remove func()) {
	c.reasonMu.Lock()
	if c.closed {
		c.reasonMu.Unlock()
		end()
		return func() {}
	}
	if c.ends == nil {
		c.ends = map[uint64]func(){}
	}
	c.endNext++
	number := c.endNext
	c.ends[number] = end
	c.reasonMu.Unlock()
	return func() {
		c.reasonMu.Lock()
		delete(c.ends, number)
		c.reasonMu.Unlock()
	}
}

// topicChanges are the subscription changes of one connection for one topic that are queued or running.
type topicChanges struct {
	count int
	// last is whether the last of them is a watch.
	last bool
}

// connectionContext is the context of the requests of a connection: it ends when the connection closes.
type connectionContext struct{ done <-chan struct{} }

func (connectionContext) Deadline() (time.Time, bool) { return time.Time{}, false }
func (c connectionContext) Done() <-chan struct{}     { return c.done }
func (connectionContext) Value(any) any               { return nil }
func (c connectionContext) Err() error {
	select {
	case <-c.done:
		return context.Canceled
	default:
		return nil
	}
}

// requestContext is the context of a request of the connection, which ends when the connection closes.
func (c *endpointConn) requestContext() context.Context { return connectionContext{done: c.done} }

// close closes the connection. It records the reason reason of the first closer before it closes the socket, and later calls do nothing.
func (c *endpointConn) close(reason string) {
	c.once.Do(func() {
		c.reasonMu.Lock()
		c.reason = reason
		c.closed = true
		ends := c.ends
		c.ends = nil
		c.reasonMu.Unlock()
		LogInfo("endpoint", "connection closed: "+reason)
		close(c.done)
		for _, end := range ends {
			end()
		}
		if err := c.conn.Close(); err != nil {
			LogError("endpoint connection close", err)
		}
	})
}

// send puts one frame into the write queue. The queue holds at most EndpointOutputFrames frames and EndpointOutputBytes
// bytes. When the queue is full, the connection does not read, so the frame is refused, the refusal is the event
// `host.buffer.dropped`, and the connection is closed. A frame of a closed connection is recorded as not sent under its name.
func (c *endpointConn) send(body []byte, name string) {
	c.sendFrame(endpointFrame{body: body, name: name})
}

// sendFrame queues frame as send does and finishes the answer of a reply that is not queued with its reason.
func (c *endpointConn) sendFrame(frame endpointFrame) {
	size := int64(len(frame.body))
	if c.queued.Add(size) > EndpointOutputBytes {
		c.queued.Add(-size)
		c.refuse(len(frame.body), fmt.Sprintf("%d bytes", EndpointOutputBytes))
		frame.answer.failed(c.closeReason())
		return
	}
	select {
	case <-c.done:
		c.queued.Add(-size)
		c.unsent(frame)
		return
	default:
	}
	select {
	case c.out <- frame:
	case <-c.done:
		c.queued.Add(-size)
		c.unsent(frame)
	default:
		c.queued.Add(-size)
		c.refuse(len(frame.body), fmt.Sprintf("%d messages", EndpointOutputFrames))
		frame.answer.failed(c.closeReason())
	}
}

// refuse records the frame that the full write queue refused and closes the connection, which does not read.
func (c *endpointConn) refuse(bytes int, limit string) {
	recordBufferDrop("endpoint output queue", bytes, limit)
	LogError("endpoint", "closing a connection that does not read")
	c.close("the output queue is full")
}

// unsent records a frame that the connection did not send because it is closed, and finishes its answer with that reason.
func (c *endpointConn) unsent(frame endpointFrame) {
	reason := c.closeReason()
	LogInfo("endpoint", frame.name+" not sent: "+reason)
	frame.answer.failed(reason)
}

// closeReason is the reason that closed the connection.
func (c *endpointConn) closeReason() string {
	c.reasonMu.Lock()
	defer c.reasonMu.Unlock()
	return c.reason
}

// write writes the frames of the queue. A write that fails because the peer closed the connection closes it as a peer
// close; any other failure is an error. The frames that remain when the connection closes are recorded as not sent.
func (c *endpointConn) write() {
	for {
		select {
		case <-c.done:
			for {
				select {
				case frame := <-c.out:
					c.queued.Add(-int64(len(frame.body)))
					c.unsent(frame)
				default:
					return
				}
			}
		case frame := <-c.out:
			c.queued.Add(-int64(len(frame.body)))
			// A frame taken while the connection closed is not written to the closed socket.
			select {
			case <-c.done:
				c.unsent(frame)
				continue
			default:
			}
			prefixed := binary.BigEndian.AppendUint32(make([]byte, 0, 4+len(frame.body)), uint32(len(frame.body)))
			if _, err := c.conn.Write(append(prefixed, frame.body...)); err != nil {
				if errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) {
					c.close("peer closed")
				} else {
					LogError("endpoint connection write", err)
					c.close("write failed")
				}
				// The answer keeps the error of the write; the log line keeps the close reason.
				frame.answer.failed(err.Error())
				c.unsent(frame)
				continue
			}
			frame.answer.finish(ReplyOutcome{Kind: ReplyWritten})
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
// changes of the same topic and messages to the page run in the order received, and the reply is sent after the page replied. An
// unwatch enters the queue only when the last change of its connection for the topic, queued or held, is a watch; any other unwatch
// changes nothing and is answered null at once. Only a watch is refused by the bound of the queue: an unwatch that enters the queue
// ends a subscription, so the queue holds at most one unwatch for each watch it holds.
func (e *Endpoint) changeInOrder(c *endpointConn, req request, parse subscriptionMethod) {
	started := time.Now()
	t, on, err := parse(e, req.Params)
	if err != nil {
		recordEndpointCall(req, started, err)
		routine.Go("endpoint-reply", func() { e.reply(c, req, nil, err) })
		return
	}
	queued, entered := e.enqueueChange(c, t, on, func() {
		err := e.change(c, t, on)
		e.changeEnded(c, t)
		recordEndpointCall(req, started, err)
		e.reply(c, req, nil, err)
	})
	if !entered {
		recordEndpointCall(req, started, nil)
		routine.Go("endpoint-reply", func() { e.reply(c, req, nil, nil) })
		return
	}
	if !queued {
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

// enqueueChange puts the subscription change job of connection c for topic t into the queue of t. entered is false for an unwatch
// whose last change, queued or held, is not a watch: it is not queued. queued is false for a watch that the bound refused.
func (e *Endpoint) enqueueChange(c *endpointConn, t topic, on bool, job func()) (queued, entered bool) {
	e.queueMu.Lock()
	defer e.queueMu.Unlock()
	pending := c.changes[t]
	if !on {
		watched := pending != nil && pending.last
		if pending == nil {
			e.mu.Lock()
			watched = c.topics[t]
			e.mu.Unlock()
		}
		if !watched {
			return false, false
		}
	}
	if !e.enqueueLocked(t, on, job) {
		return false, true
	}
	if pending == nil {
		if c.changes == nil {
			c.changes = map[topic]*topicChanges{}
		}
		pending = &topicChanges{}
		c.changes[t] = pending
	}
	pending.count++
	pending.last = on
	return true, true
}

// changeEnded removes a change of connection c for topic t that ran from its queued changes.
func (e *Endpoint) changeEnded(c *endpointConn, t topic) {
	e.queueMu.Lock()
	defer e.queueMu.Unlock()
	if pending := c.changes[t]; pending != nil {
		if pending.count--; pending.count == 0 {
			delete(c.changes, t)
		}
	}
}

// enqueue puts job into the queue of topic t and starts a goroutine when none is running. A bounded job is refused, and
// enqueue returns false, when EndpointTopicChanges jobs wait already. An unwatch and the release of the subscriptions of a
// closed connection are not bounded: each ends a subscription that a watch made, so their number follows the watches.
func (e *Endpoint) enqueue(t topic, bounded bool, job func()) bool {
	e.queueMu.Lock()
	defer e.queueMu.Unlock()
	return e.enqueueLocked(t, bounded, job)
}

// enqueueLocked is enqueue with Endpoint.queueMu held.
func (e *Endpoint) enqueueLocked(t topic, bounded bool, job func()) bool {
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
	// The end of the last connection releases the activity before the presses of the connection are released
	// (docs/spec/endpoint.md#transport).
	if len(e.conns) == 0 && e.activity {
		e.activity = !holdConnectionActivity(false)
	}
	held := make([]topic, 0, len(c.topics))
	for t := range c.topics {
		held = append(held, t)
	}
	e.mu.Unlock()
	// The close releases the presses that the connection owns, in its turn (docs/spec/exposure.md#methods).
	e.releasePresses(c)
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
		_, err = e.backend.PageRequest(context.Background(), t.window, method, mustJSON(params))
	case isHostName(t.name):
		e.backend.HostWatched(t.window, t.name, on)
	case on:
		_, err = e.backend.PageRequest(context.Background(), t.window, "status.watch", mustJSON(t.watchParams()))
	default:
		_, err = e.backend.PageRequest(context.Background(), t.window, "status.unwatch", mustJSON(t.watchParams()))
	}
	return err
}

func (e *Endpoint) run(c *endpointConn, req request, method endpointMethod) {
	// The name, the arguments, the result and the time of every endpoint method are the event host.endpoint.call.
	started := time.Now()
	scope, answer := newReplyScope()
	scope.ctx = c.requestContext()
	result, err := method(e, c, req.Params, scope)
	recordEndpointCall(req, started, err)
	// A request that ended without its result is an error that the requester receives, but only this record keeps which method
	// and why it has no result.
	var coded *RPCError
	if errors.As(err, &coded) && coded.Code == codeTimeout {
		LogError("endpoint no result", fmt.Sprintf("%s: %s", methodOf(req), coded.Message))
	}
	e.replyWithCompletion(c, req, result, err, answer)
}

// reply sends the result or the error of the request req. It does not reply to a request without id.
func (e *Endpoint) reply(c *endpointConn, req request, result any, err error) {
	e.replyWithCompletion(c, req, result, err, nil)
}

// replyWithCompletion sends the reply as reply does and finishes answer with the transport outcome of that reply: written
// after the socket write, no response for a notification, or a failed write with its reason.
func (e *Endpoint) replyWithCompletion(c *endpointConn, req request, result any, err error, answer *replyAnswer) {
	if len(req.ID) == 0 || string(req.ID) == "null" {
		answer.finish(ReplyOutcome{Kind: ReplyNoResponse})
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
		answer.failed(fmt.Sprintf("the reply cannot be encoded: %v", marshalErr))
		c.close("the reply cannot be encoded")
		return
	}
	c.sendFrame(endpointFrame{body: data, name: "reply to " + string(req.ID), answer: answer})
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
	"windows.list": func(e *Endpoint, _ *endpointConn, _ json.RawMessage, _ *ReplyScope) (any, error) {
		return e.backend.Windows(), nil
	},
	"log.query":     logQuery,
	"exposure.list": exposureList,
	"status.get":    statusGet,
	"command.run":   commandRun,
	"element.rect":  elementRequest("element.rect"),
	"element.act":   elementRequest("element.act"),
	"input.pointer": inputPointer,
	"input.key":     inputKey,
	"input.text":    inputText,

	// input.dialog.answer answers a request of host.dialog (docs/spec/exposure.md#dialogs).
	"input.dialog.answer": inputDialogAnswer,
}

// namePattern is the form of an entry name.
var namePattern = regexp.MustCompile(`^[a-z0-9-]+(\.[a-z0-9-]+)+$`)

func isHostName(name string) bool { return strings.HasPrefix(name, "host.") }

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
	window, err := windowParam(params)
	if err != nil {
		return "", err
	}
	if !e.backend.HasWindow(window) {
		return "", errMissingWindow(window)
	}
	return window, nil
}

// windowParam reads the window of params without checking that the window exists.
func windowParam(params json.RawMessage) (string, error) {
	var fields struct {
		Window json.RawMessage `json:"window"`
	}
	if err := decode(params, &fields); err != nil {
		return "", err
	}
	var window string
	if json.Unmarshal(fields.Window, &window) != nil || window == "" {
		return "", rpcError(codeInvalidParams, "window must be a non-empty string")
	}
	return window, nil
}

// named reads the window and the name of params. The window is checked first, then the name, then the existence of the window
// (endpoint.rpc.target-params-are-checked-in-order).
func (e *Endpoint) named(params json.RawMessage) (string, string, error) {
	if _, err := windowParam(params); err != nil {
		return "", "", err
	}
	var fields struct {
		Name json.RawMessage `json:"name"`
	}
	if err := decode(params, &fields); err != nil {
		return "", "", err
	}
	var name string
	if json.Unmarshal(fields.Name, &name) != nil || !namePattern.MatchString(name) {
		return "", "", rpcError(codeInvalidParams, "name is required and must have the form <owner>.<name>")
	}
	window, err := e.window(params)
	return window, name, err
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

func exposureList(e *Endpoint, _ *endpointConn, params json.RawMessage, scope *ReplyScope) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	var fields struct {
		Owner *string `json:"owner"`
	}
	if err := json.Unmarshal(params, &fields); err != nil {
		return nil, rpcError(codeInvalidParams, "%v", err)
	}
	// The host entries of owner host are answered without the main page, so they are listed while the page has not started
	// (docs/spec/exposure.md).
	reply := json.RawMessage(`{}`)
	if fields.Owner != nil {
		if *fields.Owner != "host" {
			return nil, rpcError(codeInvalidParams, "exposure.list owner must be host")
		}
	} else if reply, err = e.backend.PageRequest(scope.Context(), window, "exposure.list", json.RawMessage(`{}`)); err != nil {
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
	if list["element"] == nil {
		list["element"] = []json.RawMessage{}
	}
	return list, nil
}

func statusGet(e *Endpoint, _ *endpointConn, params json.RawMessage, reply *ReplyScope) (any, error) {
	window, name, err := e.named(params)
	if err != nil {
		return nil, err
	}
	if isHostName(name) {
		if _, ok := hostStatus[name]; !ok {
			return nil, rpcError(codeUnknownName, "status %s is not declared", name)
		}
		return e.backend.HostStatus(window, name)
	}
	return e.backend.PageRequest(reply.Context(), window, "status.get", withoutWindow(params))
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
			return topic{}, on, rpcError(codeUnknownName, "status %s is not declared", name)
		}
		return t, on, nil
	}
	var fields struct {
		Surface *string `json:"surface"`
	}
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

func commandRun(e *Endpoint, _ *endpointConn, params json.RawMessage, reply *ReplyScope) (any, error) {
	window, name, err := e.named(params)
	if err != nil {
		return nil, err
	}
	if isHostName(name) {
		if _, ok := hostCommands[name]; !ok {
			return nil, rpcError(codeUnknownName, "command %s is not declared", name)
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
		return e.backend.HostCommand(window, name, fields.Params, reply)
	}
	return e.backend.PageRequest(reply.Context(), window, "command.run", withoutWindow(params))
}

func elementRequest(method string) endpointMethod {
	return func(e *Endpoint, _ *endpointConn, params json.RawMessage, reply *ReplyScope) (any, error) {
		window, name, err := e.named(params)
		if err != nil {
			return nil, err
		}
		if isHostName(name) {
			return nil, rpcError(codeUnknownName, "the host declares no element entry %s", name)
		}
		return e.backend.PageRequest(reply.Context(), window, method, withoutWindow(params))
	}
}

var pointerPhases = map[string]bool{"move": true, "down": true, "drag": true, "up": true, "scroll": true}

func inputPointer(e *Endpoint, c *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	input, err := pointerInput(params)
	if err != nil {
		return nil, err
	}
	if err := e.backend.Pointer(window, input); err != nil {
		return nil, err
	}
	e.pointerDelivered(c, window, input)
	return nil, nil
}

// pointerInput reads the params of input.pointer into the input that the backend delivers and rejects each invalid value with the
// error -32602.
func pointerInput(params json.RawMessage) (PointerInput, error) {
	var p struct {
		Pointer        *string
		X, Y           *float64
		Phase          string
		Button         *string
		DeltaX, DeltaY float64
		Activate       bool
		Clicks         *int
	}
	if err := decode(params, &p); err != nil {
		return PointerInput{}, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(params, &fields); err != nil {
		return PointerInput{}, rpcError(codeInvalidParams, "%v", err)
	}
	for field := range fields {
		if !pointerFields[field] {
			return PointerInput{}, rpcError(codeInvalidParams, "input.pointer has no field %s", field)
		}
	}
	pointer := mainPointer
	if p.Pointer != nil {
		pointer = *p.Pointer
	}
	if !pointerName(pointer) {
		return PointerInput{}, rpcError(codeInvalidParams, "pointer must be 1 to %d characters of a-z, 0-9 and -", pointerNameMax)
	}
	if p.X == nil || p.Y == nil {
		return PointerInput{}, rpcError(codeInvalidParams, "x and y are required")
	}
	if !pointerPhases[p.Phase] {
		return PointerInput{}, rpcError(codeInvalidParams, "phase must be move, down, drag, up, or scroll")
	}
	button := "left"
	if p.Button != nil {
		button = *p.Button
	}
	if button != "left" && button != "right" {
		return PointerInput{}, rpcError(codeInvalidParams, "button must be left or right")
	}
	if p.Activate && p.Phase != "move" {
		return PointerInput{}, rpcError(codeInvalidParams, "activate applies only to phase move")
	}
	clicks := 1
	if p.Clicks != nil {
		if p.Phase != "down" && p.Phase != "up" {
			return PointerInput{}, rpcError(codeInvalidParams, "clicks applies only to phase down or up")
		}
		if *p.Clicks < 1 || *p.Clicks > pointerClicksMax {
			return PointerInput{}, rpcError(codeInvalidParams, "clicks must be from 1 to %d", pointerClicksMax)
		}
		clicks = *p.Clicks
	}
	return PointerInput{Pointer: pointer, X: *p.X, Y: *p.Y, Phase: p.Phase, Button: button, DeltaX: p.DeltaX, DeltaY: p.DeltaY,
		Activate: p.Activate, Clicks: clicks}, nil
}

// modifierBits are the modifiers names of input.key and the bits of the native input.
var modifierBits = map[string]uint{"shift": 1, "control": 2, "option": 4, "command": 8}

func inputKey(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	input, err := keyInput(params)
	if err != nil {
		return nil, err
	}
	return nil, e.backend.Key(window, input)
}

// keyInput reads the params of input.key into the input that the backend delivers and rejects each invalid value with the error
// -32602.
func keyInput(params json.RawMessage) (KeyInput, error) {
	var k struct {
		Key       string
		Text      string
		Modifiers []string
		Phase     string
	}
	if err := decode(params, &k); err != nil {
		return KeyInput{}, err
	}
	if k.Key == "" {
		return KeyInput{}, rpcError(codeInvalidParams, "key is required")
	}
	if k.Phase != "down" && k.Phase != "up" {
		return KeyInput{}, rpcError(codeInvalidParams, "phase must be down or up")
	}
	var mask uint
	for _, name := range k.Modifiers {
		bit, ok := modifierBits[name]
		if !ok {
			return KeyInput{}, rpcError(codeInvalidParams, "modifier %q is not shift, control, option, or command", name)
		}
		mask |= bit
	}
	return KeyInput{Key: k.Key, Text: k.Text, Modifiers: mask, Down: k.Phase == "down"}, nil
}

// textRange is a range of input.text: {start, length} in UTF-16 code units.
type textRange struct {
	Start  *int
	Length *int
}

// read checks the range against limit, the length of the text it lies in, or -1 for a range of the document, and returns its
// start and length.
func (r *textRange) read(name string, limit int) (int, int, error) {
	if r.Start == nil || r.Length == nil {
		return 0, 0, rpcError(codeInvalidParams, "%s must be {start, length}", name)
	}
	start, length := *r.Start, *r.Length
	if start < 0 || length < 0 || (limit >= 0 && start+length > limit) {
		return 0, 0, rpcError(codeInvalidParams, "%s is outside the text", name)
	}
	return start, length, nil
}

// inputDialogAnswer reads {window, id, paths?, cancel?, replace?} and gives the answer to the host.
func inputDialogAnswer(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	answer, err := dialogAnswerInput(params)
	if err != nil {
		return nil, err
	}
	return nil, e.backend.DialogAnswer(window, answer)
}

// dialogAnswerInput reads the params of input.dialog.answer into the answer that the host receives and rejects each invalid value
// with the error -32602.
func dialogAnswerInput(params json.RawMessage) (DialogAnswer, error) {
	var fields struct {
		ID      *string   `json:"id"`
		Paths   *[]string `json:"paths"`
		Cancel  *bool     `json:"cancel"`
		Replace *bool     `json:"replace"`
	}
	if err := decode(params, &fields); err != nil {
		return DialogAnswer{}, err
	}
	if fields.ID == nil || *fields.ID == "" {
		return DialogAnswer{}, rpcError(codeInvalidParams, "id must be a non-empty string")
	}
	answer := DialogAnswer{ID: *fields.ID, Cancel: fields.Cancel != nil && *fields.Cancel, Replace: fields.Replace != nil && *fields.Replace}
	switch {
	case answer.Cancel && fields.Paths != nil:
		return DialogAnswer{}, rpcError(codeInvalidParams, "an answer gives paths or cancel, not both")
	case answer.Cancel && fields.Replace != nil:
		return DialogAnswer{}, rpcError(codeInvalidParams, "a cancel takes no replace")
	case !answer.Cancel && fields.Paths == nil:
		return DialogAnswer{}, rpcError(codeInvalidParams, "an answer gives paths or cancel: true")
	}
	if fields.Paths != nil {
		answer.Paths = *fields.Paths
	}
	return answer, nil
}

func inputText(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	input, err := textInput(params)
	if err != nil {
		return nil, err
	}
	return nil, e.backend.Text(window, input)
}

// textInput reads the params of input.text into the composition step that the backend delivers and rejects each invalid value
// with the error -32602.
func textInput(params json.RawMessage) (TextInput, error) {
	var t struct {
		Phase       string
		Text        *string
		Selection   *textRange
		Replacement *textRange
	}
	if err := decode(params, &t); err != nil {
		return TextInput{}, err
	}
	input := TextInput{ReplacementStart: -1}
	switch t.Phase {
	case "mark":
		input.Phase = TextMark
	case "insert":
		input.Phase = TextInsert
	case "unmark":
		input.Phase = TextUnmark
	default:
		return TextInput{}, rpcError(codeInvalidParams, "phase must be mark, insert or unmark")
	}
	if input.Phase == TextUnmark {
		if t.Text != nil || t.Selection != nil || t.Replacement != nil {
			return TextInput{}, rpcError(codeInvalidParams, "unmark takes no text, selection or replacement")
		}
		return input, nil
	}
	if t.Text == nil {
		return TextInput{}, rpcError(codeInvalidParams, "text is required")
	}
	input.Text = *t.Text
	units := len(utf16.Encode([]rune(input.Text)))
	if input.Phase == TextMark {
		input.SelectionStart = units
	}
	var err error
	if t.Selection != nil {
		if input.Phase != TextMark {
			return TextInput{}, rpcError(codeInvalidParams, "selection applies to mark")
		}
		if input.SelectionStart, input.SelectionLength, err = t.Selection.read("selection", units); err != nil {
			return TextInput{}, err
		}
	}
	if t.Replacement != nil {
		if input.ReplacementStart, input.ReplacementLength, err = t.Replacement.read("replacement", -1); err != nil {
			return TextInput{}, err
		}
	}
	return input, nil
}

// The method name of the request. A request without one has an empty string.
func methodOf(req request) string {
	if req.Method == nil {
		return ""
	}
	return *req.Method
}

// The presses of the endpoint connections and the ends of the producers of watches.
//
// A press belongs to the endpoint connection whose down delivered it, and the close of that connection releases every press
// that it still owns (docs/spec/exposure.md#methods). A watch ends with status.ended when its producer ends: the surface of
// the watch closes or its document is replaced, or its window closes.

// pressKey names a press: the window, the pointer and the button of its down.
type pressKey struct{ window, pointer, button string }

// releasing marks a press whose release is being delivered, so no second release of it starts.
const releasing = -1

// openPress is a press that a delivered down opened and no delivered up ended yet.
type openPress struct {
	owner *endpointConn
	// x and y are the point of the last delivered down or drag of the press, and clicks the click count of its down.
	x, y   float64
	clicks int
	// waits is the code of the refusal that the release of a closed owner waits to be lifted, codeButtonHeld or
	// codePointerHeld, releasing while the release is delivered, and 0 while the owner is open.
	waits int
}

// pointerDelivered records the change of the presses that a delivered input of connection c makes: a down opens a press that
// c owns, a drag moves its point and an up ends it, from any connection. A down that c delivered while it closed is released
// at once, as its close releases every other press of it.
func (e *Endpoint) pointerDelivered(c *endpointConn, window string, input PointerInput) {
	key := pressKey{window, input.Pointer, input.Button}
	ended, closed := false, false
	e.pressMu.Lock()
	if e.presses == nil {
		e.presses = map[pressKey]*openPress{}
	}
	switch input.Phase {
	case "down":
		e.presses[key] = &openPress{owner: c, x: input.X, y: input.Y, clicks: input.Clicks}
		closed = c != nil && c.pressesReleased
	case "drag":
		if p := e.presses[key]; p != nil {
			p.x, p.y = input.X, input.Y
		}
	case "up":
		delete(e.presses, key)
		ended = true
	}
	e.pressMu.Unlock()
	if closed {
		e.releasePresses(c)
	}
	if ended {
		e.retryReleases(codePointerHeld)
	}
}

// releasePresses releases every press that connection c owns, in the turn of its close. Later downs of c are released when
// they are delivered.
func (e *Endpoint) releasePresses(c *endpointConn) {
	e.pressMu.Lock()
	c.pressesReleased = true
	keys := e.takeReleases(func(p *openPress) bool { return p.owner == c && p.waits == 0 })
	e.pressMu.Unlock()
	for _, key := range keys {
		e.release(key)
	}
}

// retryReleases delivers the releases that wait for the lift of the refusal code: the change of host.buttons to mask 0 lifts
// codeButtonHeld and the end of a press lifts codePointerHeld.
func (e *Endpoint) retryReleases(code int) {
	e.pressMu.Lock()
	keys := e.takeReleases(func(p *openPress) bool { return p.waits == code })
	e.pressMu.Unlock()
	for _, key := range keys {
		e.release(key)
	}
}

// takeReleases marks the presses that match as releasing and returns their keys in a fixed order. pressMu is held.
func (e *Endpoint) takeReleases(match func(*openPress) bool) []pressKey {
	var keys []pressKey
	for key, p := range e.presses {
		if match(p) {
			p.waits = releasing
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.window != b.window {
			return a.window < b.window
		}
		if a.pointer != b.pointer {
			return a.pointer < b.pointer
		}
		return a.button < b.button
	})
	return keys
}

// release delivers the up of the press key at the point of its last delivered down or drag, as a person's release. A release
// refused with codeButtonHeld or codePointerHeld waits for the lift of that refusal; a release refused in another way finds the
// press ended already and ends nothing. Both are written to the application log at the level info.
func (e *Endpoint) release(key pressKey) {
	e.pressMu.Lock()
	p := e.presses[key]
	e.pressMu.Unlock()
	if p == nil {
		return
	}
	clicks := p.clicks
	if clicks < 1 {
		clicks = 1
	}
	err := e.backend.Pointer(key.window, PointerInput{Pointer: key.pointer, X: p.x, Y: p.y, Phase: "up", Button: key.button, Clicks: clicks})
	code := 0
	var coded *RPCError
	if errors.As(err, &coded) {
		code = coded.Code
	}
	waits := err != nil && (code == codeButtonHeld || code == codePointerHeld)
	e.pressMu.Lock()
	// A delivered up of another connection may have ended the press while its release was delivered.
	current := e.presses[key] == p
	if current && waits {
		p.waits = code
	} else if current {
		delete(e.presses, key)
	}
	e.pressMu.Unlock()
	if err == nil {
		e.retryReleases(codePointerHeld)
		return
	}
	outcome := "ends nothing"
	if waits && current {
		outcome = "waits"
	}
	LogInfo("endpoint press", fmt.Sprintf("the release of the press of pointer %s button %s in window %s of a closed connection %s: %d %v",
		key.pointer, key.button, key.window, outcome, code, err))
}

// buttonsChanged retries the releases that wait for host.buttons to become mask 0.
func (e *Endpoint) buttonsChanged(value any) {
	fields, ok := value.(map[string]any)
	if !ok {
		return
	}
	if mask, ok := fields["mask"].(uint64); ok && mask == 0 {
		e.retryReleases(codeButtonHeld)
	}
}

// ProducerEnded ends the watches whose producer ended (docs/spec/exposure.md#methods): those with surface in window when surface
// is not empty, and every watch of window otherwise. In the order of the queue of each topic, each connection that holds the
// watch receives one status.ended {window, name, surface?, reason}, after the status.changed sent to it before, and the watch is
// removed without a status.unwatch to the page. A diagnostic subscription is no status watch and stays. ProducerEnded does
// not block.
func (e *Endpoint) ProducerEnded(window, surface, reason string) {
	ends := func(t topic) bool {
		if t.window != window || (surface != "" && t.surface != surface) {
			return false
		}
		_, diagnostic := diagnosticTopics[t.name]
		return !diagnostic
	}
	set := map[topic]bool{}
	e.mu.Lock()
	for t := range e.counts {
		if ends(t) {
			set[t] = true
		}
	}
	e.mu.Unlock()
	// A first watch that waits in its queue subscribes before the end runs, so its topic ends too.
	e.queueMu.Lock()
	for t := range e.queues {
		if ends(t) {
			set[t] = true
		}
	}
	e.queueMu.Unlock()
	topics := make([]topic, 0, len(set))
	for t := range set {
		topics = append(topics, t)
	}
	sort.Slice(topics, func(i, j int) bool {
		if topics[i].name != topics[j].name {
			return topics[i].name < topics[j].name
		}
		return topics[i].surface < topics[j].surface
	})
	for _, t := range topics {
		e.enqueue(t, false, func() { e.endTopic(t, reason) })
	}
}

// endTopic removes topic t from the connections that hold it and sends each of them status.ended. A connection that closed
// before keeps its subscription until its own release runs, so the count keeps it.
func (e *Endpoint) endTopic(t topic, reason string) {
	params := map[string]any{"window": t.window, "name": t.name, "reason": reason}
	if t.surface != "" {
		params["surface"] = t.surface
	}
	data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "status.ended", "params": params})
	if err != nil {
		LogError("endpoint notification", err)
		return
	}
	e.mu.Lock()
	var targets []*endpointConn
	for c := range e.conns {
		if c.topics[t] {
			delete(c.topics, t)
			targets = append(targets, c)
		}
	}
	if e.counts[t] -= len(targets); e.counts[t] <= 0 {
		delete(e.counts, t)
	}
	e.mu.Unlock()
	for _, c := range targets {
		c.send(data, "notification status.ended")
	}
}
