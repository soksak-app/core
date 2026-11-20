package host

// A message line of a sidecar is decoded once, its body once and the member image of the body once; the reader dispatches the message
// by the members that these decodes found (docs/spec/sidecars.md#messages).

import (
	"encoding/json"
	"sync/atomic"
)

// messageDecodes counts the decodes of the messages of the sidecars: of a line that a reader received, of the body of the line and of
// the member image of the body. The decode of a single member value inside them is not counted.
var messageDecodes atomic.Uint64

// MessageDecodes is the number of decodes of the messages of the sidecars since the process started. A check reads it before and
// after the lines it sends.
func MessageDecodes() uint64 { return messageDecodes.Load() }

// decodeMessage decodes data, a line of a sidecar, its body or the member image of its body, into target and counts the decode.
func decodeMessage(data []byte, target any) error {
	messageDecodes.Add(1)
	return json.Unmarshal(data, target)
}

// sidecarLine is a message line of a sidecar with its members as written. The members that the kind of the line reads are decoded from
// these values.
type sidecarLine struct {
	Operation json.RawMessage `json:"operation"`
	Request   json.RawMessage `json:"request"`
	OK        json.RawMessage `json:"ok"`
	Error     json.RawMessage `json:"error"`
	Closed    json.RawMessage `json:"closed"`
	Surface   json.RawMessage `json:"surface"`
	Body      json.RawMessage `json:"body"`
	Cids      json.RawMessage `json:"cids"`
	Process   json.RawMessage `json:"process"`
	Started   json.RawMessage `json:"started"`
}

// decodeSidecarLine decodes a message line of a sidecar; it is an error when the line is not a JSON object.
func decodeSidecarLine(line []byte) (sidecarLine, error) {
	var decoded sidecarLine
	err := decodeMessage(line, &decoded)
	return decoded, err
}

// output reads the members of a message of a surface: the surface, the answer to closed with its error, the body, the correlation
// identifiers and the members of an answer to a process query, whose request is read only on a line with process. A member that is
// present with another type is an error.
func (l sidecarLine) output() (sidecarOutput, error) {
	var output sidecarOutput
	members := []struct {
		raw    json.RawMessage
		target any
	}{{l.Surface, &output.Surface}, {l.Closed, &output.Closed}, {l.Error, &output.Error}, {l.Cids, &output.Cids}, {l.Process, &output.Process}}
	if l.Process != nil && string(l.Process) != "null" {
		members = append(members, []struct {
			raw    json.RawMessage
			target any
		}{{l.Request, &output.Request}, {l.Started, &output.Started}}...)
	}
	for _, member := range members {
		if member.raw == nil {
			continue
		}
		if err := json.Unmarshal(member.raw, member.target); err != nil {
			return sidecarOutput{}, err
		}
	}
	output.Body = l.Body
	return output, nil
}

// MessageBody is the body of a message of a sidecar with the members that the host reads from it.
type MessageBody struct {
	// Raw is the body as the sidecar wrote it.
	Raw json.RawMessage
	// errorMember is the member error of an object body, or nil.
	errorMember json.RawMessage
	// image is the member image of an object body with its members, or nil without it; imageRaw is the member as written, and
	// imageMalformed says that it is present and is not an object or null.
	image          *imageMembers
	imageRaw       json.RawMessage
	imageMalformed bool
}

// imageMembers are the members of the member image of a body that the decisions of an image message read (docs/spec/native-surfaces.md#image-regions).
type imageMembers struct {
	Want       json.RawMessage `json:"want"`
	Screen     json.RawMessage `json:"screen"`
	Detached   json.RawMessage `json:"detached"`
	Name       json.RawMessage `json:"name"`
	Token      json.RawMessage `json:"token"`
	Width      json.RawMessage `json:"width"`
	Height     json.RawMessage `json:"height"`
	Scale      json.RawMessage `json:"scale"`
	Format     json.RawMessage `json:"format"`
	Generation json.RawMessage `json:"generation"`
	Raster     json.RawMessage `json:"raster"`
	Sequence   json.RawMessage `json:"sequence"`
}

// ReadMessageBody decodes the members of the body that the host reads: the member error and the member image with its members. A body
// that is not an object holds neither.
func ReadMessageBody(raw json.RawMessage) MessageBody {
	body := MessageBody{Raw: raw}
	var members struct {
		Image json.RawMessage `json:"image"`
		Error json.RawMessage `json:"error"`
	}
	if decodeMessage(raw, &members) != nil {
		// silent: a body that is not an object is an ordinary message without an image or an error, which reaches its owner as written.
		return body
	}
	body.errorMember = members.Error
	if members.Image == nil {
		return body
	}
	body.imageRaw = members.Image
	var image imageMembers
	if decodeMessage(members.Image, &image) != nil {
		body.imageMalformed = true
		return body
	}
	body.image = &image
	return body
}
