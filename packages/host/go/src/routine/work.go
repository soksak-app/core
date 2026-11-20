package routine

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// The work of the named routines: for each name, the wakes that did work, the time they took and the bytes they handled
// (docs/spec/performance-trace.md). The host counts while the performance trace is on, and the sampler takes the totals.

// WorkTotals is the work of one routine since the last take.
type WorkTotals struct {
	Name   string
	Wakes  int64
	Micros int64
	Bytes  int64
}

var (
	counting atomic.Bool
	workMu   sync.Mutex
	work     = map[string]*WorkTotals{}
)

// CountWork turns the counting on or off; turning it on starts the totals from zero.
func CountWork(on bool) {
	workMu.Lock()
	defer workMu.Unlock()
	work = map[string]*WorkTotals{}
	counting.Store(on)
}

// Work counts one wake of the routine name that started at started and handled bytes. It does nothing while the counting is off.
func Work(name string, started time.Time, bytes int64) {
	if !counting.Load() {
		return
	}
	elapsed := time.Since(started).Microseconds()
	workMu.Lock()
	defer workMu.Unlock()
	totals := work[name]
	if totals == nil {
		totals = &WorkTotals{Name: name}
		work[name] = totals
	}
	totals.Wakes++
	totals.Micros += elapsed
	totals.Bytes += bytes
}

// TakeWork returns the totals of every routine that worked since the last take, in the order of the names, and starts them from zero.
func TakeWork() []WorkTotals {
	workMu.Lock()
	taken := work
	work = map[string]*WorkTotals{}
	workMu.Unlock()
	totals := make([]WorkTotals, 0, len(taken))
	for _, item := range taken {
		totals = append(totals, *item)
	}
	sort.Slice(totals, func(i, j int) bool { return totals[i].Name < totals[j].Name })
	return totals
}
