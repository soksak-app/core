package host

// The bound on text that an event carries (docs/spec/logging.md#bounds). A producer cuts a value to its bound before it
// copies or serializes the value, so the cost of recording does not depend on the size of the value.

import sok "github.com/soksak-app/core/packages/sok/go/src"

// CallTextBytes is the bound in bytes of the arguments and of the error text that a call event stores.
const CallTextBytes = 1024

// The bounds of the event writer and of the buffers of the host (docs/spec/logging.md#bounds).
const (
	// EventFieldsLimitBytes is the largest size in bytes of the fields of an event; an event over it is stored cut.
	EventFieldsLimitBytes = sok.EventFieldsLimitBytes
	// EventHeadBytes is the number of bytes of the fields text that a cut event keeps.
	EventHeadBytes = sok.EventHeadBytes
	// PendingMessages and PendingBytes bound each list of pending messages of a sidecar (replies and closes).
	PendingMessages = 1024
	PendingBytes    = 4 << 20
	// StartBufferBytes bounds the start buffer of the records of the host in bytes, besides StartBufferRecords.
	StartBufferBytes = 4 << 20
	// RecordTextBytes and RecordPlaceBytes are the bounds of the text and of the place of a record in an event.
	RecordTextBytes  = 8192
	RecordPlaceBytes = 1024
	// EndpointTopicChanges bounds the subscription changes that wait for the page for one topic of the endpoint.
	EndpointTopicChanges = 256
	// EndpointTopicReplies is the most replies to one connection that one answer of the page releases at once. The page holds
	// one change of a topic, and the changes that follow wait in the queue of the topic until that answer releases them in
	// order. A watch enters the queue only while fewer than EndpointTopicChanges changes wait, and after the last watch of a
	// connection the connection can queue one unwatch only, because an unwatch enters only after a watch. The released replies
	// are therefore the held change, EndpointTopicChanges waiting changes and one unwatch.
	EndpointTopicReplies = 1 + EndpointTopicChanges + 1
	// EndpointOutputFrames and EndpointOutputBytes bound the frames that wait for the socket of one connection.
	// EndpointOutputFrames equals EndpointTopicReplies, so the replies that one answer of the page releases fit in the queue
	// even before the writer sends one of them.
	EndpointOutputFrames = EndpointTopicReplies
	EndpointOutputBytes  = 16 << 20
)
