//go:build diagnostics

// The record of the layout begins of the preparations. It is compiled only with the diagnostics build tag; the release build has the
// no-op counterpart in layout_begin_record_release.go.

package host

import "sync"

// layoutBegins records, for each preparation, whether the layout trace held its viewport when the preparation called the begin of its
// layout transaction, by ticket.
var layoutBegins struct {
	sync.Mutex
	noted map[uint64]bool
}

// recordLayoutBegin records whether the viewport of ticket is noted at the begin of its transaction. The preparation calls it directly
// before the begin.
func recordLayoutBegin(ticket uint64) {
	layoutViewports.mu.Lock()
	_, noted := layoutViewports.byTicket[ticket]
	layoutViewports.mu.Unlock()
	layoutBegins.Lock()
	defer layoutBegins.Unlock()
	if layoutBegins.noted == nil {
		layoutBegins.noted = map[uint64]bool{}
	}
	layoutBegins.noted[ticket] = noted
}

// layoutBeginNoted returns whether the viewport of ticket was noted at the begin of its transaction, and whether the begin was recorded.
func layoutBeginNoted(ticket uint64) (noted, recorded bool) {
	layoutBegins.Lock()
	defer layoutBegins.Unlock()
	noted, recorded = layoutBegins.noted[ticket]
	return noted, recorded
}
