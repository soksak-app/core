package host

// The bounded buffers of the host (docs/spec/logging.md#bounds). A buffer that sheds a message refuses the newest one, so the
// messages already held keep their order, reports the refusal to its caller, and stores the event `host.buffer.dropped`.

import (
	"fmt"
	"sort"
	"sync/atomic"
)

// pendingLines is a list of messages that wait for a full write queue. It holds at most PendingMessages messages and
// PendingBytes bytes. The caller guards it.
type pendingLines struct {
	lines []queuedLine
	bytes int
}

// add appends line and raises held by one. When the bound refuses it, add keeps the list and held as they were and returns the
// bound that was reached, as `<n> messages` or `<n> bytes`; it returns "" when the line was appended. held is raised before
// the line is ordered, so a writer that sees a line ordered after it finds held above zero.
func (p *pendingLines) add(line []byte, held *atomic.Int64) string {
	switch {
	case len(p.lines) >= PendingMessages:
		return fmt.Sprintf("%d messages", PendingMessages)
	case p.bytes+len(line) > PendingBytes:
		return fmt.Sprintf("%d bytes", PendingBytes)
	}
	held.Add(1)
	p.lines = append(p.lines, queue(line))
	p.bytes += len(line)
	return ""
}

// takeBefore returns the held messages ordered before order, in the order they were added, and removes them from the list.
func (p *pendingLines) takeBefore(order uint64) []queuedLine {
	count := sort.Search(len(p.lines), func(index int) bool { return p.lines[index].order >= order })
	taken := p.lines[:count:count]
	p.lines = p.lines[count:]
	for _, line := range taken {
		p.bytes -= len(line.bytes)
	}
	if len(p.lines) == 0 {
		p.lines = nil
	}
	return taken
}

// recordBufferDrop stores the event `host.buffer.dropped` for one refused message of buffer: its size in bytes and the bound
// that refused it (`<n> messages`, `<n> bytes` or `<n> requests`).
func recordBufferDrop(buffer string, bytes int, limit string) {
	EmitHost(LevelWarn, "host.buffer.dropped", map[string]any{
		"buffer": buffer, "count": 1, "bytes": bytes, "reason": "the buffer holds " + limit,
	})
}
