package host

// The index of the event files follows the writer, and the host answers the query over them (docs/spec/logging.md#index,
// docs/spec/logging.md#query). The index and the query are implemented in the module of the command line tool, which the host
// already depends on; the host adds the goroutine that follows the writer, the endpoint method `log.query` and the host call
// `logQuery`.

import (
	"encoding/json"
	"errors"
	"os"
	"sort"
	"sync"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// reportIndexUpdate announces the lines of an update of an index that announce a change of the log (docs/spec/debug.md#following) and
// stores the event `host.log.index_rebuilt` for an index that was built from the whole file. An incremental update stores no event:
// the event would be a line that the next update indexes (docs/spec/logging.md#index).
func reportIndexUpdate(update sok.IndexUpdate) {
	announceIndexUpdate(update)
	if !update.Rebuilt {
		return
	}
	EmitHost(LevelInfo, "host.log.index_rebuilt", map[string]any{
		"file": update.File, "reason": update.Reason, "lines": update.Lines, "bytes": update.Bytes, "micros": update.Micros,
	})
}

// NewIndexReporter returns the function that reports the result of an update of an index: a rebuild is an event, and a failure is shown
// once for each distinct text in the application log as an error record of the place `log index`. It is called from one goroutine.
func NewIndexReporter() func(path string, update sok.IndexUpdate, err error) {
	lastError := map[string]string{}
	return func(path string, update sok.IndexUpdate, err error) {
		if err != nil {
			if text := err.Error(); lastError[path] != text {
				lastError[path] = text
				LogError("log index", text)
			}
			return
		}
		delete(lastError, path)
		reportIndexUpdate(update)
	}
}

// StartLogIndexer starts the goroutine that brings the index of an event file up to date after the writer wrote to the file. observe
// records the path and wakes the goroutine; the notices that arrive while it indexes become one more update of each path. after is
// called with the result of each update. stop ends the goroutine and waits until it returned.
func StartLogIndexer(after func(path string, update sok.IndexUpdate, err error)) (observe func(path string, size int64), stop func()) {
	var mu sync.Mutex
	pending := map[string]bool{}
	wake := make(chan struct{}, 1)
	quit := make(chan struct{})
	done := make(chan struct{})
	routine.Go("log-index", func() {
		defer close(done)
		for {
			select {
			case <-quit:
				return
			case <-wake:
			}
			mu.Lock()
			paths := make([]string, 0, len(pending))
			for path := range pending {
				paths = append(paths, path)
			}
			pending = map[string]bool{}
			mu.Unlock()
			sort.Strings(paths)
			for _, path := range paths {
				update, err := sok.UpdateLogIndex(path)
				if err != nil {
					if _, gone := os.Stat(path); errors.Is(gone, os.ErrNotExist) {
						// silent: the writer moved the file to a generation (`log.rotated`) or retention removed it (`log.pruned`) after the notice, and the next write to the file of the same name notifies again.
						continue
					}
					// The file may have come back between the update and the check, so the update is made once more and its result is reported.
					update, err = sok.UpdateLogIndex(path)
				}
				after(path, update, err)
			}
		}
	})
	observe = func(path string, _ int64) {
		mu.Lock()
		pending[path] = true
		mu.Unlock()
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	var once sync.Once
	stop = func() {
		once.Do(func() { close(quit) })
		<-done
	}
	return observe, stop
}

// QueryEventLogs runs the query of the request over the event files of the configuration folder. invalid is true when the request is
// not a query that the specification accepts, as opposed to a failure of the files.
func QueryEventLogs(configDir string, request []byte) (page sok.LogPage, invalid bool, err error) {
	query, err := sok.ParseLogQuery(request)
	if err != nil {
		return sok.LogPage{}, true, err
	}
	page, err = sok.QueryLogs(configDir, query, reportIndexUpdate)
	return page, false, err
}

// logQuery is the endpoint method `log.query`: one page of the events of the event files (docs/spec/endpoint.md#log-query).
func logQuery(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if len(params) == 0 || params[0] != '{' {
		return nil, rpcError(codeInvalidParams, "params must be an object")
	}
	page, invalid, err := QueryEventLogs(e.configDir, params)
	if invalid {
		return nil, rpcError(codeInvalidParams, "%v", err)
	}
	if err != nil {
		return nil, rpcError(codeHandler, "%v", err)
	}
	return page, nil
}

// LogQuery is the page's logQuery call: the query of the endpoint method `log.query` for the debug view (docs/spec/debug.md#timeline).
func (h *Host) LogQuery(requestJSON json.RawMessage) (sok.LogPage, error) {
	// The argument is checked as an object first, as every binding checks its arguments; the query refuses the members it does not know.
	if _, err := argument[map[string]json.RawMessage]("request", requestJSON); err != nil {
		return sok.LogPage{}, err
	}
	page, _, err := QueryEventLogs(h.configDir, requestJSON)
	return page, err
}
