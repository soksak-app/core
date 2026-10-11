// The notice of a change of the event log (docs/spec/debug.md#following): the debug view follows the event files with the host event
// `debug-log-changed`, and an endpoint client watches the host status `host.log`. The host publishes the notice after the index of
// a file covers the lines that announce a change.
package host

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// LogNoticeInterval is the least time between two published notices. The writer announces a change at any rate, so the publication has
// a bound; no event source can space the notices, hence the wait (docs/spec/debug.md#following).
const LogNoticeInterval = 250 * time.Millisecond

// LogNotice is the value of the host status `host.log` and the body of the host event `debug-log-changed`: the file and the size of the
// latest announcement, the number of notices published since the start, and the number of announcements that were folded into a later
// notice instead of a notice of their own.
type LogNotice struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Notices   int64  `json:"notices"`
	Coalesced int64  `json:"coalesced"`
}

// LogNotices publishes the announcements of changes of the event log with a bound on their rate. Observe returns at once, so the
// writer, the indexer and a query never wait for a window; the announcements that arrive while a notice is published or while the
// interval runs out become one notice with the latest path and size.
type LogNotices struct {
	interval time.Duration
	emit     func(LogNotice)

	mu        sync.Mutex
	path      string
	size      int64
	announced int64
	pending   bool
	value     LogNotice

	wake chan struct{}
	quit chan struct{}
	done chan struct{}
	once sync.Once
}

// NewLogNotices starts the goroutine that publishes the notices: it calls emit with each notice and then waits for interval before the
// next one. Stop ends the goroutine and waits until it returned.
func NewLogNotices(interval time.Duration, emit func(LogNotice)) *LogNotices {
	n := &LogNotices{interval: interval, emit: emit, wake: make(chan struct{}, 1), quit: make(chan struct{}), done: make(chan struct{})}
	routine.Go("debug-follow", func() {
		defer close(n.done)
		for {
			select {
			case <-n.quit:
				return
			case <-n.wake:
			}
			n.mu.Lock()
			if !n.pending {
				n.mu.Unlock()
				continue
			}
			n.pending = false
			notices := n.value.Notices + 1
			n.value = LogNotice{Path: n.path, Size: n.size, Notices: notices, Coalesced: n.announced - notices}
			notice := n.value
			n.mu.Unlock()
			n.emit(notice)
			select {
			case <-n.quit:
				return
			case <-time.After(n.interval):
			}
		}
	})
	return n
}

// Observe announces a change of the file at path (`logs/<name>`) that has size bytes.
func (n *LogNotices) Observe(path string, size int64) {
	n.mu.Lock()
	n.path, n.size, n.pending = path, size, true
	n.announced++
	n.mu.Unlock()
	select {
	case n.wake <- struct{}{}:
	default:
	}
}

// ObserveUpdate announces the change that an update of an index found, when one of its lines announces a change.
func (n *LogNotices) ObserveUpdate(update sok.IndexUpdate) {
	if update.Announcing > 0 {
		n.Observe(update.File, update.Size)
	}
}

// Value is the latest published notice, or the zero notice before the first one.
func (n *LogNotices) Value() LogNotice {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.value
}

// Stop ends the goroutine and waits until it returned.
func (n *LogNotices) Stop() {
	n.once.Do(func() { close(n.quit) })
	<-n.done
}

// currentLogNotices receives the announcements of every update of an index, also the updates that a query makes.
var currentLogNotices atomic.Pointer[LogNotices]

// UseLogNotices sets the publisher that receives the announcements of the updates of the indexes; nil removes it. An update that a
// query makes announces its lines too: the lines of a file that no writer of this host wrote (a file of a sidecar) and the lines that
// a query indexed before the indexer did would otherwise never be announced.
func UseLogNotices(notices *LogNotices) { currentLogNotices.Store(notices) }

// announceIndexUpdate passes the update of an index to the publisher of the notices.
func announceIndexUpdate(update sok.IndexUpdate) {
	if notices := currentLogNotices.Load(); notices != nil {
		notices.ObserveUpdate(update)
	}
}
