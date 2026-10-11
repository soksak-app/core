// The sidecar channels.
//
// Starts a sidecar that a plugin declared as a dependency in plugin.json on its first use and
// passes one-line JSON messages between the surface pages and the sidecar. The message body is not
// interpreted. The forms are defined in docs/spec/sidecars.md.
//
// A sidecar is found only through the staged configuration files.
//
//	environment.json                  plugins: plugins
//	modules/<plugin>/plugin.json     sidecars: sidecars
//	modules/<sidecar>/sidecar.json   executable: path of the executable inside the sidecar folder
//
// The executable is placed in the same directory as the application executable, with the same file name.

package host

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// SidecarMessage is the event value that passes a message sent by a sidecar to the page.
type SidecarMessage struct {
	Sidecar string          `json:"sidecar"`
	Surface string          `json:"surface"`
	Body    json.RawMessage `json:"body"`
}

// SidecarFailure is the event value that tells the page of the surface that was sent to a sidecar about the failure of that sidecar
// (docs/spec/sidecars.md#failure).
type SidecarFailure struct {
	Sidecar string `json:"sidecar"`
	Surface string `json:"surface"`
	Reason  string `json:"reason"`
}

// sidecarMessageLimit is the maximum number of bytes before the line break in one line of a sidecar message (docs/spec/sidecars.md#messages).
// It holds a schema snapshot of several MB with a margin of ten times or more, and it limits the memory reserved for one message to this size.
const sidecarMessageLimit = 64 << 20

type sidecarRequest struct {
	Surface string `json:"surface"`
	Root    string `json:"root,omitempty"`
	Closed  bool   `json:"closed,omitempty"`
	// Cids are the correlation identifiers of the inputs that this request continues (docs/spec/sidecars.md#protocol).
	Cids []string        `json:"cids,omitempty"`
	Body json.RawMessage `json:"body,omitempty"`
}

type sidecarEvent struct {
	Surface string          `json:"surface"`
	Body    json.RawMessage `json:"body"`
}

// sidecarOutput is the declared form of a standard output message. It distinguishes a missing surface from an empty string. When closed exists, it is
// the reply to closed, and error is the reason it could not be closed (docs/spec/sidecars.md#messages).
type sidecarOutput struct {
	Surface *string         `json:"surface"`
	Body    json.RawMessage `json:"body"`
	Closed  *bool           `json:"closed"`
	Error   *string         `json:"error"`
	// Cids are the correlation identifiers of the requests that this message answers (docs/spec/sidecars.md#protocol).
	Cids []string `json:"cids"`
}

// ClosingSurface is a surface for which the host sent closed and the sidecar has not replied yet (host.sidecars).
type ClosingSurface struct {
	Sidecar string `json:"sidecar"`
	Surface string `json:"surface"`
}

type sidecar struct {
	name string
	// version is the version that a persistent service sent in its hello reply, or nil when the reply had none.
	version    *string
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	conn       net.Conn
	persistent bool
	// servicePID is the process of the service endpoint that a persistent connection reached.
	servicePID    int
	outbox        chan []byte
	exited        chan struct{}
	muClosed      sync.Mutex
	pendingCloses pendingLines // The pending closed messages, in the order of sending
	// pendingReplies buffers the immutable image acks when the channel is full.
	// Each item is kept so that a reply with a different sequence does not overwrite another.
	pendingReplies pendingLines
	closeWaiters   map[string]chan error
	// ownerMutex serializes the close of the owner of a persistent service, and transportClosed is true once it closed the
	// transport, so the close of a replacement and the close of a stop run once between them.
	ownerMutex      sync.Mutex
	transportClosed bool
	// retained is the number of sessions that the service closed for each retain request.
	retained map[string]int
	// surfaces are the surfaces that sent requests to this process. They are the surfaces to tell about a failure. c.mu protects it.
	surfaces map[string]bool
	// stopClosing is a close of this process that Stop removed from the closing list. A sidecar on standard input and output replies to this close while it ends,
	// so that reply is not a failure (docs/spec/sidecars.md#messages). c.mu protects it.
	stopClosing map[string]int
	// read records violated and waitErr while stopping and closes exited. Stop reads them after exited.
	// violated means that reading stopped because of a protocol violation, and waitErr is the result of waiting for the process.
	violated bool
	waitErr  error
	// begin starts the write and read goroutines of a registered process.
	begin func()
}

// SidecarOwner is the window that owns a surface. It provides the root of sidecar messages and receives events.
type SidecarOwner interface {
	ProjectRoot() string
	Emit(name string, data ...any)
}

// Sidecars manages the sidecar processes of one application and the windows that own surfaces.
type Sidecars struct {
	mu sync.Mutex
	// requests remembers the requests with correlation identifiers that wait for a reply (sidecar_reply.go).
	requests requestLedger
	// declarations protects declared, persistent and basenames. An installation adds declarations while the application runs and a start reads
	// the executable outside c.mu, so it is separate from c.mu.
	declarations sync.RWMutex
	declared     map[string]string
	// versions holds the version that installed.json records for each declared sidecar.
	versions   map[string]string
	persistent map[string]bool
	running    map[string]*sidecar
	// starting is a sidecar that is starting. The start happens outside the lock, and when it ends, the channel is closed.
	starting map[string]chan struct{}
	// closing holds, for each sidecar, the surfaces whose closed was sent and not answered, with the number of those
	// closes. A surface closed again before the answer receives one answer per close.
	closing map[string]map[string]int
	// ClosingChanged is called outside the lock after closing changed. The host announces host.sidecars.
	ClosingChanged func()
	owners         map[string]SidecarOwner
	// roots are the project directories at the time a surface first sent. A sidecar finds a session by root and surface,
	// so even after the project of the window changed, the requests and closes of an already open surface are sent with this root.
	roots   map[string]string
	stopped bool
	// unannouncedLoss is a persistent sidecar whose connection was lost and whose owning surfaces have not been told yet (V5-106).
	// The start that announces the loss consumes this record; the first start has no announcement.
	unannouncedLoss map[string]bool
	// replacing holds the persistent services that Replace closes: the running and the installed version, which the
	// reconnection after the close writes to the log.
	replacing map[string]replacement
	// basenames are the basenames of the persistent sidecar executables and their sidecar names.
	basenames   map[string]string
	StopTimeout time.Duration // The deadline of Stop() that a test can inject. Default: 5 seconds.
	// ReadyTimeout is the upper bound of the time until a newly started persistent service prints its endpoint. Default: 30 seconds. A test injects it.
	ReadyTimeout time.Duration
	// RetainSending is called with the service name after Retain prepared the service and before it sends retain. It is the point at which a check inserts
	// other work in between, and it is not called when nil.
	RetainSending func(name string)
	configDir     string
	nextRequest   uint64
}

// SidecarDeclaration is one installed sidecar. Data is the content of its sidecar.json and Folder is the folder that holds it.
type SidecarDeclaration struct {
	Name   string
	Folder string
	Data   []byte
	// Version is the version that installed.json records for the sidecar.
	Version string
}

// OutdatedSidecar is a persistent sidecar whose running service has another version than the installed one
// (docs/spec/terminal-runtime.md#updates). Running is nil when the service sent no version; Sessions counts the open
// surfaces of the application that have sent to the service.
type OutdatedSidecar struct {
	Sidecar   string  `json:"sidecar"`
	Running   *string `json:"running"`
	Installed string  `json:"installed"`
	Sessions  int     `json:"sessions"`
}

// NewSidecars creates the channels from the declared sidecars. The executable is the executable path inside each Folder. It fails when the form of a declaration
// is wrong.
func NewSidecars(declarations []SidecarDeclaration, configDirectory string) (*Sidecars, error) {
	c := &Sidecars{
		declared:        map[string]string{},
		versions:        map[string]string{},
		persistent:      map[string]bool{},
		running:         map[string]*sidecar{},
		starting:        map[string]chan struct{}{},
		closing:         map[string]map[string]int{},
		owners:          map[string]SidecarOwner{},
		roots:           map[string]string{},
		unannouncedLoss: map[string]bool{},
		replacing:       map[string]replacement{},
		basenames:       map[string]string{},
		StopTimeout:     5 * time.Second,
		ReadyTimeout:    30 * time.Second,
	}
	configDirectoryProvided := strings.TrimSpace(configDirectory) != ""
	if configDirectoryProvided {
		config, err := filepath.Abs(configDirectory)
		if err != nil {
			return nil, fmt.Errorf("config directory: %w", err)
		}
		config, err = filepath.EvalSymlinks(config)
		if err != nil {
			return nil, fmt.Errorf("config directory: %w", err)
		}
		c.configDir = config
	}
	if err := c.Declare(declarations); err != nil {
		return nil, err
	}
	return c, nil
}

// Declare declares the installed sidecars (docs/spec/installation.md#applying-a-change). The running process of a
// standard input and output sidecar whose executable changed or that is no longer declared stops by the stop rules, so
// the next Send starts the new executable. A persistent service uses the new executable from its next start. An
// invalid declaration fails without a change.
func (c *Sidecars) Declare(declarations []SidecarDeclaration) error {
	changed, err := c.declare(declarations)
	if err != nil {
		return err
	}
	c.mu.Lock()
	// A sidecar that is starting registers when its start ends, so the start is awaited before the running list is
	// read.
	for {
		var wait chan struct{}
		for _, name := range changed {
			if starting := c.starting[name]; starting != nil {
				wait = starting
				break
			}
		}
		if wait == nil {
			break
		}
		c.mu.Unlock()
		<-wait
		c.mu.Lock()
	}
	processes := make([]*sidecar, 0, len(changed))
	forgot := false
	for _, name := range changed {
		if process := c.running[name]; process != nil && !process.persistent {
			forgot = c.detach(name, process) || forgot
			processes = append(processes, process)
		}
	}
	c.mu.Unlock()
	if forgot {
		c.closingChanged()
	}
	c.stopProcesses(processes, false)
	return nil
}

// declare replaces the declarations with declarations and returns the declared sidecars whose executable changed or
// that are no longer declared. Nothing changes when a declaration is invalid.
func (c *Sidecars) declare(declarations []SidecarDeclaration) ([]string, error) {
	c.declarations.Lock()
	defer c.declarations.Unlock()
	declared := map[string]string{}
	versions := map[string]string{}
	persistent := map[string]bool{}
	basenames := map[string]string{}
	for _, item := range declarations {
		name := item.Name
		file := filepath.Join(item.Folder, "sidecar.json")
		var sidecar struct {
			Executable string `json:"executable"`
			Protocol   int    `json:"protocol"`
			Transport  string `json:"transport"`
		}
		if err := json.Unmarshal(item.Data, &sidecar); err != nil {
			return nil, fmt.Errorf("%s: %w", file, err)
		}
		if sidecar.Executable == "" || path.IsAbs(sidecar.Executable) ||
			strings.Contains("/"+sidecar.Executable+"/", "/../") {
			return nil, fmt.Errorf("%s: executable must be a path inside the package", file)
		}
		if sidecar.Protocol != 1 {
			return nil, fmt.Errorf("%s: protocol must be 1", file)
		}
		if sidecar.Transport != "" && sidecar.Transport != "persistent" {
			return nil, fmt.Errorf("%s: transport %s is not supported", file, sidecar.Transport)
		}
		if sidecar.Transport == "persistent" && c.configDir == "" {
			return nil, fmt.Errorf("%s: persistent transport requires a config directory", file)
		}
		if sidecar.Transport == "persistent" {
			base := path.Base(sidecar.Executable)
			if other, exists := basenames[base]; exists {
				return nil, fmt.Errorf("%s: executable basename %s is already used by %s", file, base, other)
			}
			basenames[base] = name
			persistent[name] = true
		}
		declared[name] = filepath.Join(item.Folder, filepath.FromSlash(sidecar.Executable))
		versions[name] = item.Version
	}
	changed := []string{}
	for name, program := range c.declared {
		if declared[name] != program {
			changed = append(changed, name)
		}
	}
	c.declared, c.versions, c.persistent, c.basenames = declared, versions, persistent, basenames
	return changed, nil
}

// declaration returns the executable and the persistence of the declared sidecar name. It can be called independently of c.mu.
func (c *Sidecars) declaration(name string) (program string, persistent, ok bool) {
	c.declarations.RLock()
	defer c.declarations.RUnlock()
	program, ok = c.declared[name]
	return program, c.persistent[name], ok
}

// Send passes body that came from the surface surface of the owner window to the sidecar name.
// It serializes outside the mutex and sends through a non-blocking channel, so a slow sidecar does not block other sends.
func (c *Sidecars) Send(owner SidecarOwner, name, surface string, body json.RawMessage) error {
	return c.SendWithCids(owner, name, surface, body, nil)
}

// SendWithCids sends a page request that continues the inputs named by cids; the request line carries them as the field
// `cids`, and no field when cids is empty.
func (c *Sidecars) SendWithCids(owner SidecarOwner, name, surface string, body json.RawMessage, cids []string) error {
	c.mu.Lock()
	root, known := c.roots[surface]
	c.mu.Unlock()
	if !known {
		root = owner.ProjectRoot()
	}
	// The JSON serialization is done outside the mutex.
	line, err := json.Marshal(sidecarRequest{Surface: surface, Root: root, Cids: cids, Body: body})
	if err != nil {
		return fmt.Errorf("sidecar %s: %w", name, err)
	}
	line = append(line, '\n')
	c.traceMessage("sidecar.send", name, surface, body)

	// When this send is the first start after a connection loss, the connection notification is sent after the unlock (V5-106).
	// The notification calls back the picture reconstruction of the owner, so it cannot run inside the mutex.
	var reconnected bool
	defer func() {
		if reconnected {
			c.notifyConnection(name, nil)
		}
	}()
	// A new surface or a new service of an outdated sidecar changes host.sidecars, which is announced after the unlock.
	var outdatedChanged bool
	defer func() {
		if outdatedChanged {
			c.closingChanged()
		}
	}()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return fmt.Errorf("sidecars are stopped")
	}
	if _, _, ok := c.declaration(name); !ok {
		return fmt.Errorf("sidecar %s is not declared by any plugin", name)
	}
	if other, ok := c.owners[surface]; ok && other != owner {
		return fmt.Errorf("surface %s belongs to another window", surface)
	}
	process, started, err := c.process(name)
	if err != nil {
		return err
	}
	if started {
		reconnected = c.unannouncedLoss[name]
		delete(c.unannouncedLoss, name)
	}
	// The lock was released while starting, so the owner of the surface is checked again.
	if other, ok := c.owners[surface]; ok && other != owner {
		return fmt.Errorf("surface %s belongs to another window", surface)
	}
	outdatedChanged = (started || !process.surfaces[surface]) && c.outdated(process)
	process.surfaces[surface] = true
	c.owners[surface] = owner
	if _, ok := c.roots[surface]; !ok {
		c.roots[surface] = root
	}

	// Sends to the channel without blocking. When the channel is full, it returns the "is not keeping up" error.
	select {
	case process.outbox <- line:
		if len(cids) > 0 {
			c.requests.add(name, surface, cids, monotonicNanos())
			EmitHostCids(LevelInfo, "host.sidecar.request", cids, map[string]any{"name": name, "surface": surface, "bytes": len(body)})
		}
		return nil
	default:
		return fmt.Errorf("sidecar %s is not keeping up", name)
	}
}

// SendResponse passes a reply (such as an image return) to the sidecar.
// When the channel is full, it buffers the immutable replies in order and the write goroutine sends them.
func (c *Sidecars) SendResponse(name, surface, image string, body json.RawMessage) error {
	// First serializes the JSON outside the mutex.
	type response struct {
		Surface string          `json:"surface"`
		Body    json.RawMessage `json:"body"`
	}
	line, err := json.Marshal(response{Surface: surface, Body: body})
	if err != nil {
		return fmt.Errorf("sidecar %s: response serialize: %w", name, err)
	}
	line = append(line, '\n')

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return fmt.Errorf("sidecars are stopped")
	}
	process, ok := c.running[name]
	if !ok {
		return fmt.Errorf("sidecar %s is not running", name)
	}
	select {
	case <-process.exited:
		return fmt.Errorf("sidecar %s response channel is disconnected", name)
	default:
	}

	// Sends to the channel without blocking. When the channel is full, it buffers.
	select {
	case process.outbox <- line:
		return nil
	default:
		// The channel is full, so the immutable replies are kept in order.
		responseKey := surface + ":" + image + ":" + string(body)
		process.muClosed.Lock()
		limit := process.pendingReplies.add(line)
		process.muClosed.Unlock()
		if limit != "" {
			recordBufferDrop("sidecar "+name+" pending replies", len(line), limit)
			return fmt.Errorf("sidecar %s: the pending replies reached %s, so a reply of surface %s is dropped", name, limit, surface)
		}
		LogInfo("sidecar "+name, fmt.Sprintf("response queue full, buffering %s", responseKey))
		return nil
	}
}

// Close notifies all running sidecars of the removed surface.
func (c *Sidecars) Close(surface string) {
	if c.closeSurface(surface) {
		c.closingChanged()
	}
	c.replaceIdle()
}

// closeSurface sends closed for surface to the running sidecars and returns true when it recorded a surface that waits for a reply.
func (c *Sidecars) closeSurface(surface string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.owners[surface]; !ok {
		return false
	}
	delete(c.owners, surface)
	root := c.roots[surface]
	delete(c.roots, surface)

	line, err := json.Marshal(sidecarRequest{Surface: surface, Root: root, Closed: true})
	if err != nil {
		LogError("sidecar close "+surface, fmt.Sprintf("marshal: %v", err))
		return false
	}
	line = append(line, '\n')

	for _, process := range c.running {
		if c.closing[process.name] == nil {
			c.closing[process.name] = map[string]int{}
		}
		c.closing[process.name][surface]++
		// Sends to the channel without blocking. When the channel is full, it stores it in pendingCloses.
		select {
		case process.outbox <- line:
		default:
			// The channel is full, so the closed messages are kept in the order of sending.
			process.muClosed.Lock()
			limit := process.pendingCloses.add(line)
			process.muClosed.Unlock()
			if limit != "" {
				// The close is not sent, so no reply to it comes: the surface is not waited for. The sidecar keeps its session
				// until it ends.
				recordBufferDrop("sidecar "+process.name+" pending closes", len(line), limit)
				if c.closing[process.name][surface]--; c.closing[process.name][surface] == 0 {
					delete(c.closing[process.name], surface)
				}
				continue
			}
			LogInfo("sidecar "+process.name, fmt.Sprintf("close %s: outbox full, buffered", surface))
		}
	}
	return len(c.running) > 0
}

// Closing returns the surfaces for which closed was sent and no reply was received, in the order of sidecar and surface (host.sidecars).
func (c *Sidecars) Closing() []ClosingSurface {
	c.mu.Lock()
	defer c.mu.Unlock()
	list := []ClosingSurface{}
	for sidecar, surfaces := range c.closing {
		for surface := range surfaces {
			list = append(list, ClosingSurface{Sidecar: sidecar, Surface: surface})
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Sidecar != list[j].Sidecar {
			return list[i].Sidecar < list[j].Sidecar
		}
		return list[i].Surface < list[j].Surface
	})
	return list
}

// Outdated returns the persistent sidecars whose running service has another version than the installed one, sorted by
// sidecar (host.sidecars, docs/spec/terminal-runtime.md#updates).
func (c *Sidecars) Outdated() []OutdatedSidecar {
	c.mu.Lock()
	defer c.mu.Unlock()
	list := []OutdatedSidecar{}
	for name, process := range c.running {
		if !c.outdated(process) {
			continue
		}
		sessions := 0
		for surface := range process.surfaces {
			if c.owners[surface] != nil {
				sessions++
			}
		}
		c.declarations.RLock()
		installed := c.versions[name]
		c.declarations.RUnlock()
		list = append(list, OutdatedSidecar{Sidecar: name, Running: process.version, Installed: installed, Sessions: sessions})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Sidecar < list[j].Sidecar })
	return list
}

// outdated reports whether process is a persistent service whose version differs from the installed version of its
// sidecar. A service that sent no version is of an earlier version. It is called with c.mu held.
func (c *Sidecars) outdated(process *sidecar) bool {
	if !process.persistent {
		return false
	}
	c.declarations.RLock()
	installed := c.versions[process.name]
	c.declarations.RUnlock()
	return process.version == nil || *process.version != installed
}

// replacement is the versions of a persistent service that is being replaced.
type replacement struct {
	running   *string
	installed string
	// pid is the process of the service endpoint, which ends before the installed service starts.
	pid int
}

// Replace replaces the persistent service of the sidecar name, whose `hello` version differs from the installed
// version: it sends close-owner and shutdown, closes the connection, and the reconnection that follows starts the
// installed executable through the creation path and notifies the surfaces that sent to the sidecar
// (docs/spec/terminal-runtime.md#updates). A sidecar without a running service of another version is refused.
func (c *Sidecars) Replace(ctx context.Context, name string) error {
	c.mu.Lock()
	process, running := c.running[name]
	if c.stopped || !running || !c.outdated(process) {
		c.mu.Unlock()
		return fmt.Errorf("sidecar %s: no running service of another version than the installed one", name)
	}
	if _, replacing := c.replacing[name]; replacing {
		c.mu.Unlock()
		return fmt.Errorf("sidecar %s: a replacement is running", name)
	}
	c.declarations.RLock()
	installed := c.versions[name]
	c.declarations.RUnlock()
	c.replacing[name] = replacement{running: process.version, installed: installed, pid: process.servicePID}
	c.mu.Unlock()
	if err := c.closePersistentOwner(process, ctx); err != nil {
		c.mu.Lock()
		delete(c.replacing, name)
		c.mu.Unlock()
		return fmt.Errorf("sidecar %s: replace: %w", name, err)
	}
	return nil
}

// replaceIdle replaces each outdated service that has no open surface of this application.
func (c *Sidecars) replaceIdle() {
	for _, item := range c.Outdated() {
		c.mu.Lock()
		_, busy := c.replacing[item.Sidecar]
		c.mu.Unlock()
		if item.Sessions != 0 || busy {
			continue
		}
		name := item.Sidecar
		routine.Go("sidecar-replace", func() {
			ctx, cancel := context.WithTimeout(context.Background(), c.StopTimeout)
			defer cancel()
			if err := c.Replace(ctx, name); err != nil {
				LogError("replace", err)
			}
		})
	}
}

// closingChanged announces that closing changed. Call it outside the lock.
func (c *Sidecars) closingChanged() {
	if c.ClosingChanged != nil {
		c.ClosingChanged()
	}
}

// closeAnswered records that the sidecar process answered the closed of surface. When it was not closing that surface and it is not a close that Stop removed from
// the list, it returns the reason of a protocol violation. The reason it could not close is written to the log. Call it outside the lock.
func (c *Sidecars) closeAnswered(process *sidecar, surface string, closed bool, failure *string) string {
	if !closed {
		return "invalid message: closed is not true"
	}
	name := process.name
	c.mu.Lock()
	pending := take(c.closing[name], surface)
	if len(c.closing[name]) == 0 {
		delete(c.closing, name)
	}
	stopped := !pending && take(process.stopClosing, surface)
	c.mu.Unlock()
	if !pending && !stopped {
		return "unexpected close answer for " + surface
	}
	if failure != nil {
		LogError("sidecar "+name, fmt.Sprintf("close %s: %s", surface, *failure))
	}
	if pending {
		c.closingChanged()
	}
	return ""
}

// take lowers the count of key in counts by one and returns true when it did; a key whose count reaches 0 is removed.
func take(counts map[string]int, key string) bool {
	if counts[key] == 0 {
		return false
	}
	counts[key]--
	if counts[key] == 0 {
		delete(counts, key)
	}
	return true
}

// forgetClosing deletes the closes that the sidecar name did not answer for an ended process or a lost connection. Call it while holding c.mu;
// it returns true when it deleted something.
func (c *Sidecars) forgetClosing(name string) bool {
	if len(c.closing[name]) == 0 {
		return false
	}
	delete(c.closing, name)
	return true
}

// CloseOwner notifies the sidecars of all surfaces of the owner window. Call it when the window closes.
func (c *Sidecars) CloseOwner(owner SidecarOwner) {
	c.mu.Lock()
	surfaces := make([]string, 0)
	for surface, current := range c.owners {
		if current == owner {
			surfaces = append(surfaces, surface)
		}
	}
	c.mu.Unlock()
	for _, surface := range surfaces {
		c.Close(surface)
	}
}

// Stop ends all sidecars. It closes the channels to send an EOF signal to the write goroutines,
// waits for the process exit for at most stopTimeout, and forces termination when a process does not respond.
func (c *Sidecars) Stop() { c.stop(false) }

// Detach stops the sidecars as Stop does, except that a persistent service gets no close-owner and no shutdown: its
// connection ends and its sessions stay, for the application that starts after an application update
// (docs/spec/installation.md#application-update).
func (c *Sidecars) Detach() { c.stop(true) }

// stop stops the sidecars; with detach a persistent service only loses its connection.
func (c *Sidecars) stop(detach bool) {
	c.mu.Lock()
	c.stopped = true
	// A sidecar that is starting is registered when it ends, so the running list is read after waiting for that start.
	for len(c.starting) > 0 {
		var wait chan struct{}
		for _, starting := range c.starting {
			wait = starting
			break
		}
		c.mu.Unlock()
		<-wait
		c.mu.Lock()
	}
	// A send to outbox happens inside the lock and only to a sidecar in the running list. It is removed from the list before the channel is closed,
	// so the surface close of a window that closes during the termination sends nothing. A sidecar on standard input and output ends, so it does not reply
	// to the close. A persistent service replies to a close sent before the stop ahead of the close-owner reply, so that surface is kept until the reply or the end of
	// the connection (docs/spec/sidecars.md#messages).
	processes := make([]*sidecar, 0, len(c.running))
	forgot := false
	for name, process := range c.running {
		processes = append(processes, process)
		forgot = c.detach(name, process) || forgot
	}
	c.mu.Unlock()
	if forgot {
		c.closingChanged()
	}
	c.stopProcesses(processes, detach)
}

// detach removes a process that stops from the running list. A standard input and output sidecar ends, so its
// unanswered closes move to stopClosing. It is called with c.mu held and returns true when closing changed.
func (c *Sidecars) detach(name string, process *sidecar) bool {
	delete(c.running, name)
	if process.persistent {
		return false
	}
	process.stopClosing = c.closing[name]
	return c.forgetClosing(name)
}

// stopProcesses stops processes, which are out of the running list, by the stop rules and waits until they end
// (docs/spec/sidecars.md#declaration-and-startup).
func (c *Sidecars) stopProcesses(processes []*sidecar, detach bool) {
	// Closes the channels of all sidecars to send an EOF signal.
	// The write goroutine detects the closed channel and closes stdin.
	for _, process := range processes {
		if !process.persistent {
			close(process.outbox)
		}
	}

	// Waits for all processes in parallel. When the deadline passes, it kills and waits for the exited channel.
	ctx, cancel := context.WithTimeout(context.Background(), c.StopTimeout)
	defer cancel()

	var wg sync.WaitGroup
	for _, process := range processes {
		wg.Add(1)
		p := process
		routine.Go("sidecar-close", func() {
			defer wg.Done()
			if p.persistent && detach {
				p.ownerMutex.Lock()
				defer p.ownerMutex.Unlock()
				if !p.transportClosed {
					p.closeTransport()
				}
				return
			}
			if p.persistent {
				if err := c.closePersistentOwner(p, ctx); err != nil {
					LogError("sidecar "+p.name, fmt.Sprintf("close owner: %v", err))
				}
				return
			}
			// When the read() goroutine reads the output to the end and waits for the process, the process.exited channel closes.
			killed := false
			select {
			case <-p.exited:
			case <-ctx.Done():
				// The deadline passed. Forces termination.
				err := p.cmd.Process.Kill()
				killed = err == nil
				if err != nil && !errors.Is(err, os.ErrProcessDone) {
					LogError("sidecar "+p.name, fmt.Sprintf("kill: %v", err))
				}
				// Waits until the read() goroutine ends.
				<-p.exited
			}
			// An exit caused by a pipe closed after a forced termination or a violation is not reported (docs/spec/sidecars.md#declaration-and-startup).
			switch {
			case killed:
				LogError("sidecar "+p.name, "did not end within the stop timeout and was killed")
			case p.violated:
			case p.waitErr != nil:
				LogError("sidecar "+p.name, "exited while stopping: "+exitStatus(p.cmd, p.waitErr))
			}
		})
	}
	wg.Wait()
}

// RetainedSurface is a surface sent with retain and the project root that opened that surface.
type RetainedSurface struct {
	Surface string `json:"surface"`
	Root    string `json:"root"`
}

// retainTimeout is the time to wait for the service to answer retain. It includes the time to close the sessions.
const retainTimeout = 10 * time.Second

// Retain closes, in each persistent service, the sessions of this application that are not in surfaces, and returns the number of closed sessions.
// It keeps a surface to which this process already sent a message even when it is not in the list. When the service is not running and there is no
// endpoint, there are no sessions, so it skips the service.
func (c *Sidecars) Retain(surfaces []RetainedSurface) (int, error) {
	if surfaces == nil {
		return 0, errors.New("retain requires a surfaces list")
	}
	c.mu.Lock()
	// Starts from a non-nil slice so that an empty list is also sent as a JSON array.
	keep := append(make([]RetainedSurface, 0, len(surfaces)+len(c.roots)), surfaces...)
	for surface, root := range c.roots {
		keep = append(keep, RetainedSurface{Surface: surface, Root: root})
	}
	c.mu.Unlock()
	c.declarations.RLock()
	names := make([]string, 0, len(c.persistent))
	for name, persistent := range c.persistent {
		if persistent {
			names = append(names, name)
		}
	}
	c.declarations.RUnlock()
	for _, item := range keep {
		if item.Surface == "" || item.Root == "" {
			return 0, fmt.Errorf("retain surface entry is invalid: %+v", item)
		}
	}
	total := 0
	for _, name := range names {
		request := fmt.Sprintf("%d", atomic.AddUint64(&c.nextRequest, 1))
		line, err := json.Marshal(map[string]any{"operation": "retain", "request": request, "surfaces": keep})
		if err != nil {
			return total, err
		}
		line = append(line, '\n')
		waiter := make(chan error, 1)
		c.mu.Lock()
		if c.stopped {
			c.mu.Unlock()
			return total, errors.New("sidecars are stopped")
		}
		if _, running := c.running[name]; !running {
			program, _, ok := c.declaration(name)
			if !ok {
				c.mu.Unlock()
				return total, fmt.Errorf("sidecar %s is not declared by any plugin", name)
			}
			endpoint := filepath.Join(c.configDir, "services", filepath.Base(program), "endpoint.json")
			if _, err := os.Stat(endpoint); errors.Is(err, os.ErrNotExist) {
				c.mu.Unlock()
				continue
			} else if err != nil {
				c.mu.Unlock()
				return total, fmt.Errorf("sidecar %s: read endpoint: %w", name, err)
			}
		}
		if _, _, err := c.process(name); err != nil {
			c.mu.Unlock()
			return total, err
		}
		c.mu.Unlock()
		if c.RetainSending != nil {
			c.RetainSending(name)
		}
		// A send to outbox happens inside the lock and only to a sidecar in the running list. Stop may have closed that outbox while the service was being prepared,
		// so it checks again and sends without blocking.
		c.mu.Lock()
		if c.stopped {
			c.mu.Unlock()
			return total, errors.New("sidecars are stopped")
		}
		process, ok := c.running[name]
		if !ok {
			c.mu.Unlock()
			return total, fmt.Errorf("sidecar %s is not running", name)
		}
		process.closeWaiters[request] = waiter
		select {
		case process.outbox <- line:
		default:
			delete(process.closeWaiters, request)
			c.mu.Unlock()
			return total, fmt.Errorf("sidecar %s is not keeping up", name)
		}
		c.mu.Unlock()
		timer := time.NewTimer(retainTimeout)
		select {
		case err := <-waiter:
			timer.Stop()
			if err != nil {
				return total, fmt.Errorf("sidecar %s: retain: %w", name, err)
			}
		case <-timer.C:
			return total, fmt.Errorf("sidecar %s: retain was not answered within %s", name, retainTimeout)
		}
		c.mu.Lock()
		total += process.retained[request]
		delete(process.retained, request)
		c.mu.Unlock()
	}
	return total, nil
}

func (c *Sidecars) closePersistentOwner(process *sidecar, ctx context.Context) error {
	process.ownerMutex.Lock()
	defer process.ownerMutex.Unlock()
	if process.transportClosed {
		// Another caller closed the owner and the transport.
		return nil
	}
	return c.closeOwnerAndShutdown(process, ctx)
}

// closeOwnerAndShutdown sends close-owner and shutdown, waits for each answer and closes the transport. It is called
// with process.ownerMutex held.
func (c *Sidecars) closeOwnerAndShutdown(process *sidecar, ctx context.Context) error {
	request := fmt.Sprintf("%d", atomic.AddUint64(&c.nextRequest, 1))
	waiter := make(chan error, 1)
	defer func() {
		c.mu.Lock()
		delete(process.closeWaiters, request)
		c.mu.Unlock()
	}()
	c.mu.Lock()
	process.closeWaiters[request] = waiter
	c.mu.Unlock()
	line, err := json.Marshal(map[string]string{"operation": "close-owner", "request": request})
	if err != nil {
		return err
	}
	line = append(line, '\n')
	select {
	case process.outbox <- line:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-waiter:
		if err != nil {
			process.closeTransport()
			return err
		}
		shutdown := fmt.Sprintf("%d", atomic.AddUint64(&c.nextRequest, 1))
		shutdownWaiter := make(chan error, 1)
		c.mu.Lock()
		process.closeWaiters[shutdown] = shutdownWaiter
		c.mu.Unlock()
		shutdownLine, marshalErr := json.Marshal(map[string]string{"operation": "shutdown", "request": shutdown})
		if marshalErr != nil {
			return marshalErr
		}
		shutdownLine = append(shutdownLine, '\n')
		select {
		case process.outbox <- shutdownLine:
		case <-ctx.Done():
			return ctx.Err()
		}
		select {
		case shutdownErr := <-shutdownWaiter:
			process.closeTransport()
			return shutdownErr
		case <-ctx.Done():
			process.closeTransport()
			return ctx.Err()
		}
	case <-ctx.Done():
		process.closeTransport()
		return ctx.Err()
	}
}

// process returns the running sidecar, and when there is none, starts and registers it. It is called holding c.mu and returns holding it. The start
// waits for the process launch and for the connection and the authentication of a persistent service, so it happens with the lock released. Meanwhile the requests of other sidecars
// do not wait, and the requests of the same sidecar wait for that start to end. started tells whether this call started it.
func (c *Sidecars) process(name string) (process *sidecar, started bool, err error) {
	for {
		if process, ok := c.running[name]; ok {
			return process, false, nil
		}
		if c.stopped {
			return nil, false, errors.New("sidecars are stopped")
		}
		wait, ok := c.starting[name]
		if !ok {
			break
		}
		c.mu.Unlock()
		<-wait
		c.mu.Lock()
	}
	done := make(chan struct{})
	c.starting[name] = done
	c.mu.Unlock()
	process, err = c.launch(name)
	c.mu.Lock()
	delete(c.starting, name)
	close(done)
	if err != nil {
		return nil, false, err
	}
	// Stop reads the running list after waiting for the starts to end, so a start that ended while stopping is also registered and Stop cleans it up.
	c.running[name] = process
	process.begin()
	if c.stopped {
		return nil, false, errors.New("sidecars are stopped")
	}
	return process, true, nil
}

// launch starts the sidecar name. Call it without the lock; it does not register.
func (c *Sidecars) launch(name string) (*sidecar, error) {
	program, persistent, ok := c.declaration(name)
	if !ok {
		return nil, fmt.Errorf("sidecar %s is not declared by any plugin", name)
	}
	if persistent {
		return c.processPersistent(name)
	}
	cmd := exec.Command(program)
	// The host reads the standard error line by line and writes each line as a record (docs/spec/sidecars.md#log).
	cmd.Stderr = &recordWriter{layer: "sidecar", where: name}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		return nil, fmt.Errorf("sidecar %s: %w", name, err)
	}
	EmitHost(LevelInfo, "host.sidecar.start", map[string]any{"name": name, "pid": cmd.Process.Pid})
	PerformanceProcessAdd("sidecar", name, cmd.Process.Pid)
	process := &sidecar{
		name: name, cmd: cmd, stdin: stdin,
		outbox:       make(chan []byte, 256),
		exited:       make(chan struct{}),
		closeWaiters: make(map[string]chan error),
		surfaces:     make(map[string]bool),
	}
	process.begin = func() {
		routine.Go("sidecar-write", func() { c.write(process) })       // write goroutine: reads from the outbox channel and writes to stdin.
		routine.Go("sidecar-read", func() { c.read(process, stdout) }) // read goroutine: reads from stdout and passes events.
	}
	return process, nil
}

type persistentEndpoint struct {
	Protocol uint64 `json:"protocol"`
	PID      int    `json:"pid"`
	Socket   string `json:"socket"`
	Token    string `json:"token"`
}

// helloTimeout is the upper bound of the time until the service answers hello (docs/spec/terminal-runtime.md).
const helloTimeout = 5 * time.Second

// serviceEndpointLine reads the first line that a newly started service prints to stdout. When no line arrives within limit, it ends that service,
// reaps it, returns true as timedOut, and returns the failure of that cleanup as err.
func serviceEndpointLine(cmd *exec.Cmd, stdout io.Reader, limit time.Duration) (line []byte, timedOut bool, err error) {
	type result struct {
		line []byte
		err  error
	}
	read := make(chan result, 1)
	routine.Go("sidecar-read-line", func() {
		line, err := bufio.NewReader(stdout).ReadBytes('\n')
		read <- result{line, err}
	})
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case got := <-read:
		return got.line, false, got.err
	case <-timer.C:
	}
	// When the service ends, stdout closes and the read goroutine also ends.
	if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return nil, true, fmt.Errorf("ending the service failed: %w", err)
	}
	<-read
	var exit *exec.ExitError
	if err := cmd.Wait(); err != nil && !errors.As(err, &exit) {
		return nil, true, fmt.Errorf("reaping the service failed: %w", err)
	}
	return nil, true, nil
}

func (c *Sidecars) processPersistent(name string) (*sidecar, error) {
	program, _, ok := c.declaration(name)
	if !ok {
		return nil, fmt.Errorf("sidecar %s is not declared by any plugin", name)
	}
	serviceDir := filepath.Join(c.configDir, "services", filepath.Base(program))
	current, err := platform.Current()
	if err != nil {
		return nil, err
	}
	if err := current.CreatePrivateDirectories(serviceDir); err != nil {
		return nil, fmt.Errorf("sidecar %s: create service directory: %w", name, err)
	}
	if err := current.SecureServiceDirectory(serviceDir); err != nil {
		return nil, fmt.Errorf("sidecar %s: secure service directory: %w", name, err)
	}
	endpointPath := filepath.Join(serviceDir, "endpoint.json")
	var endpoint persistentEndpoint
	var cmd *exec.Cmd
	if data, err := os.ReadFile(endpointPath); err == nil {
		if err := json.Unmarshal(data, &endpoint); err != nil {
			return nil, fmt.Errorf("sidecar %s: invalid endpoint: %w", name, err)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		cmd = exec.Command(program, "--service-dir", serviceDir, "--log-dir", filepath.Join(c.configDir, "logs"))
		// A persistent service belongs to the lifetime of the configuration
		// directory and not of this application process. A new session is started so that the recovery service does not
		// end together with the application when it exits abnormally.
		if err := current.NewSession(cmd); err != nil {
			return nil, fmt.Errorf("sidecar %s: new session: %w", name, err)
		}
		cmd.Stdin = nil
		// The service lives longer than this host, so it writes to its own log file and not to the standard error of the host
		// (docs/spec/hosts.md#application-log). There is no endpoint, so no service writes to that file.
		serviceLog, err := OpenLog(ServiceLogPath(c.configDir, program))
		if err != nil {
			return nil, fmt.Errorf("sidecar %s: service log: %w", name, err)
		}
		cmd.Stderr = serviceLog
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return nil, errors.Join(fmt.Errorf("sidecar %s: service stdout: %w", name, err), serviceLog.Close())
		}
		startErr := cmd.Start()
		// The service has a duplicated descriptor, so the file that the host opened is closed.
		if err := errors.Join(startErr, serviceLog.Close()); err != nil {
			return nil, fmt.Errorf("sidecar %s: %w", name, err)
		}
		line, timedOut, err := serviceEndpointLine(cmd, stdout, c.ReadyTimeout)
		if timedOut {
			message := fmt.Sprintf("sidecar %s: the service did not print its endpoint within %v", name, c.ReadyTimeout)
			if err != nil {
				return nil, fmt.Errorf("%s; %w", message, err)
			}
			return nil, errors.New(message)
		}
		// When stdout closes without a line, the service ended before it printed the endpoint.
		if errors.Is(err, io.EOF) && len(line) == 0 {
			return nil, fmt.Errorf("sidecar %s: service exited before endpoint", name)
		}
		if err != nil {
			return nil, fmt.Errorf("sidecar %s: service startup: %w", name, err)
		}
		if err := json.Unmarshal(line, &endpoint); err != nil || endpoint.Protocol == 0 {
			var failure struct {
				Error    string              `json:"error"`
				Endpoint *persistentEndpoint `json:"endpoint"`
			}
			if json.Unmarshal(line, &failure) == nil && failure.Error != "" && failure.Endpoint != nil {
				endpoint = *failure.Endpoint
			} else {
				if err == nil {
					err = errors.New("endpoint is incomplete")
				}
				return nil, fmt.Errorf("sidecar %s: service endpoint: %w", name, err)
			}
		}
	} else {
		return nil, fmt.Errorf("sidecar %s: read endpoint: %w", name, err)
	}
	exists, err := current.ServiceProcessExists(endpoint.PID)
	if err != nil {
		return nil, err
	}
	if !exists {
		if err := os.Remove(endpointPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("sidecar %s: remove stale endpoint: %w", name, err)
		}
		// This endpoint was left by a service that ended abnormally. Only this record, which was confirmed to be stale, is removed,
		// and the common single creation path is entered.
		return c.processPersistent(name)
	}
	if endpoint.Protocol != 1 {
		return nil, fmt.Errorf("sidecar %s: service protocol %d is not supported", name, endpoint.Protocol)
	}
	if endpoint.PID == 0 || endpoint.Socket == "" || endpoint.Token == "" {
		return nil, fmt.Errorf("sidecar %s: service endpoint is incomplete", name)
	}
	conn, err := net.Dial("unix", endpoint.Socket)
	if err != nil {
		return nil, fmt.Errorf("sidecar %s: connect authenticated service: %w", name, err)
	}
	reader := bufio.NewReader(conn)
	hello, err := json.Marshal(map[string]any{"operation": "hello", "protocol": 1, "token": endpoint.Token, "client": c.configDir})
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: encode hello: %w", name, err)
	}
	hello = append(hello, '\n')
	if _, err := conn.Write(hello); err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: hello: %w", name, err)
	}
	// The hello reply has a deadline so that a service that does not answer does not make the requests and Stop of this sidecar wait forever.
	if err := conn.SetReadDeadline(time.Now().Add(helloTimeout)); err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: hello deadline: %w", name, err)
	}
	responseLine, err := reader.ReadBytes('\n')
	if errors.Is(err, os.ErrDeadlineExceeded) {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: the service did not answer hello within %v", name, helloTimeout)
	}
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: hello response: %w", name, err)
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: hello deadline: %w", name, err)
	}
	var response struct {
		Operation string  `json:"operation"`
		Protocol  *uint64 `json:"protocol"`
		Version   *string `json:"version"`
		OK        bool    `json:"ok"`
		Error     string  `json:"error"`
	}
	if err := json.Unmarshal(responseLine, &response); err != nil || response.Operation != "hello" {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: authentication handshake failed: invalid hello response", name)
	}
	if !response.OK {
		conn.Close()
		if response.Error == "" {
			response.Error = "authentication failed"
		}
		return nil, fmt.Errorf("sidecar %s: authentication handshake failed: %s", name, response.Error)
	}
	if response.Protocol == nil || *response.Protocol != 1 {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: service protocol mismatch in hello response", name)
	}
	EmitHost(LevelInfo, "host.sidecar.connect", map[string]any{"name": name, "pid": endpoint.PID, "spawned": cmd != nil})
	PerformanceProcessAdd("sidecar", name, endpoint.PID)
	process := &sidecar{
		name: name, cmd: cmd, conn: conn, persistent: true, version: response.Version, servicePID: endpoint.PID,
		outbox: make(chan []byte, 256), exited: make(chan struct{}),
		closeWaiters: make(map[string]chan error), surfaces: make(map[string]bool),
	}
	process.begin = func() {
		routine.Go("sidecar-write-persistent", func() { c.writePersistent(process) })
		routine.Go("sidecar-read-persistent", func() { c.readPersistent(process, reader) })
	}
	return process, nil
}

// write first empties the queue, writes the held messages when the queue is empty, and then waits for the queue.
// The held messages arise after the queue became full, so they must go out after the messages that entered the queue first.
// When the queue closes, it writes up to the held messages and then closes stdin.
func (c *Sidecars) write(process *sidecar) {
	defer func() {
		if err := process.stdin.Close(); err != nil {
			LogError("sidecar "+process.name, fmt.Sprintf("close stdin: %v", err))
		}
	}()
	for {
		// 1. Writes all messages in the channel without blocking (a select with default).
		for drained := false; !drained; {
			select {
			case line, ok := <-process.outbox:
				if !ok {
					// The channel closed. Ends after writing all held messages.
					c.writePending(process)
					return
				}
				if !c.writeLine(process, line) {
					return
				}
			default:
				drained = true
			}
		}

		// 2. When the queue is empty, writes all held messages.
		if !c.writePending(process) {
			return
		}

		// 3. Now waits for the next item from the channel (blocking).
		line, ok := <-process.outbox
		if !ok {
			// The channel closed. Ends after writing all held messages.
			c.writePending(process)
			return
		}
		if !c.writeLine(process, line) {
			return
		}
	}
}

func (c *Sidecars) writePersistent(process *sidecar) {
	for {
		for drained := false; !drained; {
			select {
			case line, ok := <-process.outbox:
				if !ok {
					c.writePersistentPending(process)
					return
				}
				if !c.writePersistentLine(process, line) {
					return
				}
			default:
				drained = true
			}
		}
		if !c.writePersistentPending(process) {
			return
		}
		line, ok := <-process.outbox
		if !ok {
			c.writePersistentPending(process)
			return
		}
		if !c.writePersistentLine(process, line) {
			return
		}
	}
}

func (c *Sidecars) writePersistentLine(process *sidecar, line []byte) bool {
	if _, err := process.conn.Write(line); err != nil {
		LogError("sidecar "+process.name, fmt.Sprintf("write: %v", err))
		return false
	}
	return true
}

func (c *Sidecars) writePersistentPending(process *sidecar) bool {
	process.muClosed.Lock()
	replies, closes := process.pendingReplies.take(), process.pendingCloses.take()
	process.muClosed.Unlock()
	for _, line := range replies {
		if !c.writePersistentLine(process, line) {
			return false
		}
	}
	for _, line := range closes {
		if !c.writePersistentLine(process, line) {
			return false
		}
	}
	return true
}

func (c *Sidecars) writeLine(process *sidecar, line []byte) bool {
	if _, err := process.stdin.Write(line); err != nil {
		LogError("sidecar "+process.name, fmt.Sprintf("write: %v", err))
		return false
	}
	return true
}

// writePending takes the held messages at once and writes the returns first and the closes last.
func (c *Sidecars) writePending(process *sidecar) bool {
	process.muClosed.Lock()
	replies, closes := process.pendingReplies.take(), process.pendingCloses.take()
	process.muClosed.Unlock()
	for _, line := range replies {
		if !c.writeLine(process, line) {
			return false
		}
	}
	for _, line := range closes {
		if !c.writeLine(process, line) {
			return false
		}
	}
	return true
}

// read passes the output of the sidecar to the window that owns the surface. When the output ends or the protocol is violated, and the process is not ending,
// it ends that process and tells each surface that was sent to that process about the failure (docs/spec/sidecars.md#failure).
// ownedSurface is a surface to tell about a failure and its owner window.
type ownedSurface struct {
	surface string
	owner   SidecarOwner
}

func (c *Sidecars) read(process *sidecar, stdout io.ReadCloser) {
	violation := c.relay(process, stdout)
	// Closes the read end so that a process that is still writing is not blocked in a write. If it blocks, it does not end until the forced termination after the deadline of Stop.
	if err := stdout.Close(); err != nil {
		LogError("sidecar "+process.name, fmt.Sprintf("close output: %v", err))
	}
	c.mu.Lock()
	failed := !c.stopped && c.running[process.name] == process
	owned := make([]ownedSurface, 0, len(process.surfaces))
	forgot := false
	if c.running[process.name] == process {
		delete(c.running, process.name)
		forgot = c.forgetClosing(process.name)
	}
	if failed {
		// While ending, Stop closes the outbox. Otherwise it is closed here to end the write goroutine.
		// Every send to outbox happens inside c.mu and only to a process that is in running.
		close(process.outbox)
		for surface := range process.surfaces {
			if owner := c.owners[surface]; owner != nil {
				owned = append(owned, ownedSurface{surface, owner})
			}
		}
	}
	c.mu.Unlock()
	if forgot {
		c.closingChanged()
	}
	if !failed {
		// It is stopping. A violation is written to the log and no failure event is sent. Stop decides the report of the exit.
		c.requests.forget(process.name)
		if violation != "" {
			LogError("sidecar "+process.name, "failed: "+violation)
		}
		process.violated = violation != ""
		process.waitErr = process.cmd.Wait()
		flushStderr(process.cmd)
		EmitHost(LevelInfo, "host.sidecar.exit", map[string]any{"name": process.name, "pid": process.cmd.Process.Pid,
			"status": exitStatus(process.cmd, process.waitErr), "stopping": true})
		PerformanceProcessRemove(process.cmd.Process.Pid)
		close(process.exited)
		return
	}
	// The protocol state after a failure is undefined, so the process is ended.
	reason := violation
	if err := process.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		reason = fmt.Sprintf("%s; kill: %v", reason, err)
	}
	exit := exitStatus(process.cmd, process.cmd.Wait())
	flushStderr(process.cmd)
	if violation == "" {
		reason = "output closed: " + exit
	}
	EmitHost(LevelInfo, "host.sidecar.exit", map[string]any{"name": process.name, "pid": process.cmd.Process.Pid,
		"status": exit, "stopping": false})
	PerformanceProcessRemove(process.cmd.Process.Pid)
	close(process.exited)
	LogError("sidecar "+process.name, "failed: "+reason)
	c.failRequests(process.name, reason)
	for _, item := range owned {
		item.owner.Emit("sidecar-failure", SidecarFailure{Sidecar: process.name, Surface: item.surface, Reason: reason})
	}
}

// exitStatus writes the exit of the ended process cmd as `exit status <code>` or `signal <number>`
// (docs/spec/sidecars.md#declaration-and-startup). waitErr is the result of cmd.Wait. For an error of waiting that is not an exit status,
// it writes that error.
func exitStatus(cmd *exec.Cmd, waitErr error) string {
	var exit *exec.ExitError
	if waitErr != nil && !errors.As(waitErr, &exit) {
		return fmt.Sprintf("wait: %v", waitErr)
	}
	current, err := platform.Current()
	if err != nil {
		return fmt.Sprintf("exit status of process %d: %v", cmd.ProcessState.Pid(), err)
	}
	text, err := current.ExitStatus(cmd.ProcessState)
	if err != nil {
		return fmt.Sprintf("exit status of process %d: %v", cmd.ProcessState.Pid(), err)
	}
	return text
}

// relay passes the messages of the output to the owner window. It returns an empty string when the output ends, and the reason when the protocol is violated or the read
// fails. When the part of a line before the line break exceeds sidecarMessageLimit bytes, it does not buffer more and fails.
func (c *Sidecars) relay(process *sidecar, stdout io.Reader) string {
	scanner := bufio.NewScanner(stdout)
	// The buffer holds the limit and one line break. A longer line is bufio.ErrTooLong.
	scanner.Buffer(make([]byte, 0, 64*1024), sidecarMessageLimit+1)
	for scanner.Scan() {
		var output sidecarOutput
		if err := json.Unmarshal(scanner.Bytes(), &output); err != nil {
			return fmt.Sprintf("invalid message: %v", err)
		}
		if output.Surface == nil {
			return "invalid message: surface is missing"
		}
		if output.Closed != nil {
			if violation := c.closeAnswered(process, *output.Surface, *output.Closed, output.Error); violation != "" {
				return violation
			}
			continue
		}
		if output.Body == nil {
			return "invalid message: body is missing"
		}
		event := sidecarEvent{Surface: *output.Surface, Body: output.Body}
		c.recordReply(process.name, event.Surface, output.Cids, event.Body)
		c.mu.Lock()
		owner := c.owners[event.Surface]
		addressed := process.surfaces[event.Surface]
		c.mu.Unlock()
		// A message of a surface that was never sent to this process is a protocol violation. When it was sent and there is no owner window, the message was sent by the sidecar
		// after the surface closed, so it is discarded (docs/spec/sidecars.md#messages).
		if !addressed {
			return "unknown surface " + event.Surface
		}
		if owner != nil {
			// Checks whether it is an image envelope
			if c.tryHandleImageEnvelope(owner, process.name, event.Surface, event.Body) {
				continue
			}
			c.traceMessage("sidecar.receive", process.name, event.Surface, event.Body)
			owner.Emit("sidecar-message", SidecarMessage{Sidecar: process.name, Surface: event.Surface, Body: event.Body})
		} else {
			logDroppedMessage(process.name, event)
		}
	}
	if err := scanner.Err(); errors.Is(err, bufio.ErrTooLong) {
		return fmt.Sprintf("message exceeds %d bytes", sidecarMessageLimit)
	} else if err != nil {
		return fmt.Sprintf("read: %v", err)
	}
	return ""
}

func (c *Sidecars) readPersistent(process *sidecar, reader *bufio.Reader) {
	violation := c.readPersistentLines(process, reader)
	process.conn.Close()
	wasCurrent := false
	var owned []ownedSurface
	c.mu.Lock()
	stopping := c.stopped
	waiters := make([]chan error, 0, len(process.closeWaiters))
	for request, waiter := range process.closeWaiters {
		delete(process.closeWaiters, request)
		waiters = append(waiters, waiter)
	}
	forgot := false
	if c.running[process.name] == process {
		delete(c.running, process.name)
		c.unannouncedLoss[process.name] = true
		wasCurrent = true
		forgot = c.forgetClosing(process.name)
		if violation != "" {
			for surface := range process.surfaces {
				if owner := c.owners[surface]; owner != nil {
					owned = append(owned, ownedSurface{surface, owner})
				}
			}
		}
	} else if c.stopped {
		// This is a connection that the stop removed from the running list. The service finishes the closes that were not answered by itself.
		forgot = c.forgetClosing(process.name)
	}
	c.mu.Unlock()
	if forgot {
		c.closingChanged()
	}
	for _, waiter := range waiters {
		waiter <- errors.New("persistent service disconnected before close-owner ack")
	}
	close(process.exited)
	EmitHost(LevelInfo, "host.sidecar.disconnect", map[string]any{"name": process.name, "pid": process.servicePID,
		"stopping": stopping, "violation": violation})
	PerformanceProcessRemove(process.servicePID)
	if stopping {
		c.requests.forget(process.name)
	}
	if violation != "" {
		// The service violated the protocol. The same message would end the next connection too, so it is not connected again immediately, and the next send
		// connects again through the creation path (docs/spec/terminal-runtime.md#service-transport).
		LogError("sidecar "+process.name, "failed: "+violation)
		c.failRequests(process.name, violation)
		for _, item := range owned {
			item.owner.Emit("sidecar-failure", SidecarFailure{Sidecar: process.name, Surface: item.surface, Reason: violation})
		}
		return
	}
	// The connection was lost. It connects again immediately without waiting for the next send; if the service is alive, it
	// attaches again, and if it died, the stale endpoint cleanup of processPersistent respawns it (V5-106).
	if wasCurrent {
		c.failRequests(process.name, "connection lost")
		c.revivePersistent(process.name)
	}
}

// readPersistentLines reads the lines of a persistent connection and passes replies and events. It returns an empty string when the connection ends and the reason when the protocol is
// violated. When the part of a line before the line break exceeds sidecarMessageLimit bytes, it does not buffer more and
// fails (docs/spec/terminal-runtime.md#service-transport).
func (c *Sidecars) readPersistentLines(process *sidecar, reader *bufio.Reader) string {
	scanner := bufio.NewScanner(reader)
	// The buffer holds the limit and one line break. A longer line is bufio.ErrTooLong.
	scanner.Buffer(make([]byte, 0, 64*1024), sidecarMessageLimit+1)
	for scanner.Scan() {
		line := scanner.Bytes()
		var value map[string]json.RawMessage
		if err := json.Unmarshal(line, &value); err != nil {
			return fmt.Sprintf("invalid message: %v", err)
		}
		var operation string
		if raw, present := value["operation"]; present {
			if err := json.Unmarshal(raw, &operation); err != nil {
				return fmt.Sprintf("invalid message: operation: %v", err)
			}
		}
		if operation == "closed-owner" || operation == "shutdown" || operation == "retained" {
			var request string
			if err := json.Unmarshal(value["request"], &request); err != nil || request == "" {
				return fmt.Sprintf("invalid message: %s request is not a non-empty string", operation)
			}
			var ok bool
			if err := json.Unmarshal(value["ok"], &ok); err != nil {
				return fmt.Sprintf("invalid message: %s ok: %v", operation, err)
			}
			var reason string
			if raw, present := value["error"]; present {
				if err := json.Unmarshal(raw, &reason); err != nil {
					return fmt.Sprintf("invalid message: %s error: %v", operation, err)
				}
			}
			var closed int
			if operation == "retained" && ok {
				if err := json.Unmarshal(value["closed"], &closed); err != nil {
					return fmt.Sprintf("invalid message: retained closed: %v", err)
				}
			}
			c.mu.Lock()
			waiter := process.closeWaiters[request]
			delete(process.closeWaiters, request)
			if operation == "retained" && waiter != nil {
				if process.retained == nil {
					process.retained = map[string]int{}
				}
				process.retained[request] = closed
			}
			c.mu.Unlock()
			if waiter != nil {
				if ok {
					waiter <- nil
				} else if reason == "" {
					waiter <- fmt.Errorf("%s failed", operation)
				} else {
					waiter <- errors.New(reason)
				}
			}
			continue
		}
		var output sidecarOutput
		if err := json.Unmarshal(line, &output); err != nil {
			return fmt.Sprintf("invalid message: %v", err)
		}
		if output.Surface == nil {
			return "invalid message: surface is missing"
		}
		if output.Closed != nil {
			if violation := c.closeAnswered(process, *output.Surface, *output.Closed, output.Error); violation != "" {
				return violation
			}
			continue
		}
		if output.Body == nil {
			return "invalid message: body is missing"
		}
		event := sidecarEvent{Surface: *output.Surface, Body: output.Body}
		c.recordReply(process.name, event.Surface, output.Cids, event.Body)
		c.mu.Lock()
		owner := c.owners[event.Surface]
		c.mu.Unlock()
		if owner != nil {
			if c.tryHandleImageEnvelope(owner, process.name, event.Surface, event.Body) {
				continue
			}
			c.traceMessage("sidecar.receive", process.name, event.Surface, event.Body)
			owner.Emit("sidecar-message", SidecarMessage{Sidecar: process.name, Surface: event.Surface, Body: event.Body})
		} else {
			logDroppedMessage(process.name, event)
		}
	}
	// net.ErrClosed means that this host closed the connection (cleanup after termination or failure). When the peer closes, it is EOF and there is no error.
	if err := scanner.Err(); errors.Is(err, bufio.ErrTooLong) {
		return fmt.Sprintf("message exceeds %d bytes", sidecarMessageLimit)
	} else if err != nil && !errors.Is(err, net.ErrClosed) {
		LogError("sidecar "+process.name, fmt.Sprintf("persistent read: %v", err))
	}
	return ""
}

// revivePersistent connects a lost persistent connection again and tells the owning surfaces the result (V5-106). When
// another path already restarted it or it is ending, it does nothing. It tries once for one connection loss;
// a failure is reported by a notification, and the next send passes through the same path again.
func (c *Sidecars) revivePersistent(name string) {
	c.awaitReplacedService(name)
	announced, failure := c.reviveAttempt(name)
	// The first attempt in which the connection is refused is evidence that the endpoint no longer listens; even if a recycled pid
	// passes kill(pid, 0), the socket is dead. Only in a restart that has a loss record, it discards the endpoint
	// and tries once more (V5-106). The contract of the send path is unchanged: the
	// live-unreachable report of a cold send does not change the endpoint.
	if failure != nil && refusedConnect(failure, name) {
		if program, _, ok := c.declaration(name); ok {
			endpoint := filepath.Join(c.configDir, "services", filepath.Base(program), "endpoint.json")
			if err := os.Remove(endpoint); err != nil && !errors.Is(err, os.ErrNotExist) {
				LogError("sidecar "+name, fmt.Sprintf("remove refused endpoint: %v", err))
			}
		}
		announced, failure = c.reviveAttempt(name)
	}
	c.mu.Lock()
	replaced, replacing := c.replacing[name]
	delete(c.replacing, name)
	c.mu.Unlock()
	switch {
	case failure != nil:
		// The start failed. The loss record is kept so that the next start announces it.
		LogError("sidecar "+name, fmt.Sprintf("connection lost; restart failed: %v", failure))
		c.notifyConnection(name, failure)
	case announced && replacing:
		// The replacement closed the connection on purpose and the installed service started: an expected state.
		running := "none"
		if replaced.running != nil {
			running = *replaced.running
		}
		LogInfo("sidecar "+name, fmt.Sprintf("service %s replaced by %s", running, replaced.installed))
		c.notifyConnection(name, nil)
		c.closingChanged()
	case announced:
		// When another path (a send) already restarted it, that call also sent the notification.
		LogError("sidecar "+name, "connection lost; restarted")
		c.notifyConnection(name, nil)
	}
}

// awaitReplacedService waits until the process of the service that Replace closed has ended, so the installed service
// starts after it (docs/spec/terminal-runtime.md#updates). A process that does not end within the stop timeout fails
// the replacement: the error line names the sidecar, and the reconnection that follows reaches the service that still
// runs, so the sidecar stays outdated.
func (c *Sidecars) awaitReplacedService(name string) {
	c.mu.Lock()
	replaced, replacing := c.replacing[name]
	c.mu.Unlock()
	if !replacing || replaced.pid <= 0 {
		return
	}
	failed := func(reason string) {
		LogError("sidecar "+name, "replace: "+reason)
		c.mu.Lock()
		delete(c.replacing, name)
		c.mu.Unlock()
	}
	current, err := platform.Current()
	if err != nil {
		failed(err.Error())
		return
	}
	ended, err := current.WaitServiceProcessEnd(replaced.pid, c.StopTimeout)
	switch {
	case err != nil:
		failed(err.Error())
	case !ended:
		failed(fmt.Sprintf("the service process %d did not end within %v", replaced.pid, c.StopTimeout))
	}
}

// reviveAttempt is one restart. When another path already restarted it, it returns announced=false,
// and when the start fails, it returns failure.
func (c *Sidecars) reviveAttempt(name string) (announced bool, failure error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return false, nil
	}
	if _, running := c.running[name]; running {
		return false, nil
	}
	_, started, err := c.process(name)
	if err != nil {
		return false, err
	}
	if !started {
		return false, nil
	}
	announced = c.unannouncedLoss[name]
	delete(c.unannouncedLoss, name)
	return announced, nil
}

// refusedConnect tells whether the sentence is the connection failure sentence of processPersistent.
func refusedConnect(failure error, name string) bool {
	return failure != nil && strings.HasPrefix(failure.Error(), fmt.Sprintf("sidecar %s: connect authenticated service:", name))
}

// notifyConnection tells the owning surfaces about a persistent connection that was connected again (V5-106). The window sends the picture configure of that sidecar
// again (SidecarReconnected), and the surface receives the connection event and reopens its session.
// When the start failed, it announces the connection loss and its reason.
func (c *Sidecars) notifyConnection(name string, failure error) {
	type ownerSurface struct {
		surface string
		owner   SidecarOwner
	}
	c.mu.Lock()
	entries := make([]ownerSurface, 0, len(c.owners))
	for surface, owner := range c.owners {
		entries = append(entries, ownerSurface{surface, owner})
	}
	c.mu.Unlock()
	body := map[string]any{"event": "connection", "connected": failure == nil}
	if failure != nil {
		body["reason"] = failure.Error()
	}
	raw, err := json.Marshal(body)
	if err != nil {
		LogError("sidecar "+name, fmt.Sprintf("connection notice serialization: %v", err))
		return
	}
	reconfigured := map[SidecarOwner]bool{}
	for _, item := range entries {
		if failure == nil && !reconfigured[item.owner] {
			reconfigured[item.owner] = true
			if window, ok := item.owner.(interface{ SidecarReconnected(sidecar string) }); ok {
				window.SidecarReconnected(name)
			}
		}
		item.owner.Emit("sidecar-message", SidecarMessage{Sidecar: name, Surface: item.surface, Body: raw})
	}
}

// tryHandleImageEnvelope checks whether the event is an image envelope and handles it. It returns true for an envelope.
// logDroppedMessage records, with its body, a sidecar message that is discarded because there is no owner window.
func logDroppedMessage(sidecar string, event sidecarEvent) {
	LogInfo("sidecar "+sidecar, fmt.Sprintf("message for surface %s dropped: no window owns the surface: %s", event.Surface, event.Body))
}

func (c *Sidecars) tryHandleImageEnvelope(owner SidecarOwner, sidecarName, surface string, body json.RawMessage) bool {
	// Checks whether the owner has the image envelope decision handler
	if decider, ok := owner.(interface {
		DecideImageEnvelope(sidecarName, surface string, body json.RawMessage) bool
	}); ok {
		return decider.DecideImageEnvelope(sidecarName, surface, body)
	}

	return false
}

// closeTransport closes the connection and the outbox of a persistent service. It is called with ownerMutex held.
func (s *sidecar) closeTransport() {
	s.conn.Close()
	close(s.outbox)
	s.transportClosed = true
}

// flushStderr writes the last text of the standard error that ended without a line break, after the process ended, to the record.
func flushStderr(cmd *exec.Cmd) {
	if w, ok := cmd.Stderr.(*recordWriter); ok {
		w.Flush()
	}
}

// recordWriter reads the standard error of a non-persistent sidecar line by line and writes it as text records of level info
// (docs/spec/sidecars.md#log). Text before a line break arrives is held until Flush.
type recordWriter struct {
	layer, where string
	mu           sync.Mutex
	partial      []byte
}

func (w *recordWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.partial = append(w.partial, p...)
	for {
		end := bytes.IndexByte(w.partial, '\n')
		if end < 0 {
			return len(p), nil
		}
		line := bytes.TrimSuffix(w.partial[:end], []byte("\r"))
		Log(Entry{"info", w.layer, w.where, string(line)})
		w.partial = w.partial[end+1:]
	}
}

// Flush writes the last text that ended without a line break to the record.
func (w *recordWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.partial) > 0 {
		Log(Entry{"info", w.layer, w.where, string(w.partial)})
		w.partial = nil
	}
}

// traceMessage writes a request sent to a sidecar or a message received from a sidecar, with the whole body, as an event of the performance trace
// (docs/spec/diagnostics.md). When this trace is off, it creates nothing.
func (c *Sidecars) traceMessage(event, sidecar, surface string, body json.RawMessage) {
	if c.configDir == "" {
		return
	}
	PerformanceObserve("host", func() map[string]any {
		return map[string]any{"event": event, "sidecar": sidecar, "surface": surface, "body": body}
	})
}
