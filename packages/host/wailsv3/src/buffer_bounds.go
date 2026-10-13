package host

// The bounded buffers of the host (docs/spec/logging.md#bounds). A buffer that sheds a message refuses the newest one, so the
// messages already held keep their order, reports the refusal to its caller, and stores the event `host.buffer.dropped`.

import "fmt"

// pendingLines is a list of messages that wait for a full write queue. It holds at most PendingMessages messages and
// PendingBytes bytes. The caller guards it.
type pendingLines struct {
	lines []queuedLine
	bytes int
}

// add appends line. When the bound refuses it, add keeps the list as it was and returns the bound that was reached, as
// `<n> messages` or `<n> bytes`; it returns "" when the line was appended.
func (p *pendingLines) add(line []byte) string {
	switch {
	case len(p.lines) >= PendingMessages:
		return fmt.Sprintf("%d messages", PendingMessages)
	case p.bytes+len(line) > PendingBytes:
		return fmt.Sprintf("%d bytes", PendingBytes)
	}
	p.lines = append(p.lines, queue(line))
	p.bytes += len(line)
	return ""
}

// take returns the held messages in the order they were added and empties the list.
func (p *pendingLines) take() []queuedLine {
	lines := p.lines
	p.lines, p.bytes = nil, 0
	return lines
}

// recordBufferDrop stores the event `host.buffer.dropped` for one refused message of buffer: its size in bytes and the bound
// that refused it (`<n> messages`, `<n> bytes` or `<n> requests`).
func recordBufferDrop(buffer string, bytes int, limit string) {
	EmitHost(LevelWarn, "host.buffer.dropped", map[string]any{
		"buffer": buffer, "count": 1, "bytes": bytes, "reason": "the buffer holds " + limit,
	})
}
