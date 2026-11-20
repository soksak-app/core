package host

// The surface of a process (docs/spec/sidecars.md#process-identity): the host walks the parent processes of the process of an
// endpoint connection to the first process whose parent is a running sidecar, asks that sidecar with a process query, and reads
// the chain again before it accepts the answer.

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// ProcessIdentityError is a refusal of the surface of a process, the endpoint error 1014 (docs/spec/sidecars.md#process-identity).
type ProcessIdentityError struct{ Text string }

func (e *ProcessIdentityError) Error() string { return e.Text }

// processQuery is a process query that waits for its answer. answer has room for the one answer.
type processQuery struct {
	process int
	answer  chan processAnswer
}

// processAnswer is the answer of a sidecar to a process query: surface is nil when the sidecar did not start the process for a
// surface, and started is the start time that the sidecar recorded, in milliseconds since the Unix epoch.
type processAnswer struct {
	surface *string
	started int64
}

// chainLink is one process of the walk with the parent and the start time that the walk read.
type chainLink struct {
	pid   int
	entry platform.ProcessEntry
}

// ProcessSurface answers the surface of the process peer: the surface for which a sidecar started the nearest ancestor of peer,
// peer included, whose parent is a running sidecar of the host (docs/spec/sidecars.md#process-identity). A refusal is a
// *ProcessIdentityError. The end of ctx ends the wait for the answer of the sidecar.
func (c *Sidecars) ProcessSurface(ctx context.Context, peer int) (string, error) {
	current, err := platform.Current()
	if err != nil {
		return "", err
	}
	sidecars := c.sidecarProcesses()
	var chain []chainLink
	var owner *sidecar
	for pid := peer; ; {
		entry, found, err := current.ProcessEntry(pid)
		if err != nil {
			return "", err
		}
		if !found {
			return "", &ProcessIdentityError{Text: fmt.Sprintf("process %d changed while its surface was checked", peer)}
		}
		chain = append(chain, chainLink{pid: pid, entry: entry})
		if process, ok := sidecars[entry.Parent]; ok {
			owner = process
			break
		}
		if entry.Parent <= 1 {
			return "", &ProcessIdentityError{Text: fmt.Sprintf("process %d is not a process of a surface: no parent process of it is a running sidecar of the application that started it for a surface", peer)}
		}
		pid = entry.Parent
	}
	root := chain[len(chain)-1]
	c.declarations.RLock()
	declares := c.processes[owner.name]
	c.declarations.RUnlock()
	if !declares {
		return "", &ProcessIdentityError{Text: fmt.Sprintf("process %d is a process of sidecar %s, which declares no processes of surfaces", peer, owner.name)}
	}
	answer, err := c.askProcess(ctx, owner, root.pid)
	if err != nil {
		return "", err
	}
	for _, link := range chain {
		entry, found, err := current.ProcessEntry(link.pid)
		if err != nil {
			return "", err
		}
		if !found || entry != link.entry {
			return "", &ProcessIdentityError{Text: fmt.Sprintf("process %d changed while its surface was checked", peer)}
		}
	}
	if answer.surface == nil {
		return "", &ProcessIdentityError{Text: fmt.Sprintf("process %d is not a process of a surface: sidecar %s did not start process %d for a surface", peer, owner.name, root.pid)}
	}
	if answer.started != root.entry.Started {
		return "", &ProcessIdentityError{Text: fmt.Sprintf("process %d changed while its surface was checked", peer)}
	}
	return *answer.surface, nil
}

// sidecarProcesses maps the process of each running sidecar to it: the process that the host started for a sidecar on standard
// input and output, and the service process of a persistent connection.
func (c *Sidecars) sidecarProcesses() map[int]*sidecar {
	c.mu.Lock()
	defer c.mu.Unlock()
	processes := map[int]*sidecar{}
	for _, process := range c.running {
		switch {
		case process.persistent && process.servicePID > 0:
			processes[process.servicePID] = process
		case !process.persistent && process.cmd != nil && process.cmd.Process != nil:
			processes[process.cmd.Process.Pid] = process
		}
	}
	return processes
}

// askProcess sends the process query for pid to process and waits for its answer, the end of the reading of the sidecar or the
// end of ctx (docs/spec/sidecars.md#messages).
func (c *Sidecars) askProcess(ctx context.Context, process *sidecar, pid int) (processAnswer, error) {
	c.mu.Lock()
	if c.running[process.name] != process {
		c.mu.Unlock()
		return processAnswer{}, fmt.Errorf("sidecar %s ended before the process query of process %d", process.name, pid)
	}
	c.processRequests++
	request := c.processRequests
	query := processQuery{process: pid, answer: make(chan processAnswer, 1)}
	line, err := json.Marshal(map[string]any{"process": pid, "request": request})
	if err != nil {
		c.mu.Unlock()
		return processAnswer{}, err
	}
	line = append(line, '\n')
	// A send to outbox happens inside the lock and only to a sidecar in the running list.
	select {
	case process.outbox <- queue(line, c.now()):
	default:
		c.mu.Unlock()
		return processAnswer{}, fmt.Errorf("sidecar %s is not keeping up", process.name)
	}
	if process.processQueries == nil {
		process.processQueries = map[int64]processQuery{}
	}
	process.processQueries[request] = query
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(process.processQueries, request)
		c.mu.Unlock()
	}()
	select {
	case answer := <-query.answer:
		return answer, nil
	case <-process.exited:
		return processAnswer{}, fmt.Errorf("sidecar %s ended before it answered the process query of process %d", process.name, pid)
	case <-ctx.Done():
		return processAnswer{}, ctx.Err()
	}
}

// processAnswered delivers the answer of a process query that output holds, and returns the violation of a line that answers no
// query of this process or names another process than it (docs/spec/sidecars.md#failure).
func (c *Sidecars) processAnswered(process *sidecar, output sidecarOutput) string {
	if output.Request == nil {
		return "invalid message: request is missing"
	}
	c.mu.Lock()
	query, ok := process.processQueries[*output.Request]
	if ok {
		delete(process.processQueries, *output.Request)
	}
	c.mu.Unlock()
	if !ok {
		return fmt.Sprintf("unexpected process answer for request %d", *output.Request)
	}
	if *output.Process != query.process {
		return fmt.Sprintf("process answer for request %d names process %d, not %d", *output.Request, *output.Process, query.process)
	}
	answer := processAnswer{surface: output.Surface}
	if output.Surface != nil {
		if output.Started == nil {
			return fmt.Sprintf("process answer for request %d has a surface and no started", *output.Request)
		}
		answer.started = *output.Started
	}
	query.answer <- answer
	return ""
}
