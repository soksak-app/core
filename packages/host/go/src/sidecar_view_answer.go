package host

import (
	"context"
	"encoding/json"
)

// answerViewSidecar sends a view request and, when req.Answer is true, resolves with the body of the reply that names its surface and
// correlation identifiers, as sidecarSend does (docs/spec/persistent-services.md#owned-session-messages).
func (s *Surfaces) answerViewSidecar(ctx context.Context, req ViewSidecarSendRequest) (json.RawMessage, error) {
	if !req.Answer {
		return nil, s.sendViewSidecar(ctx, req)
	}
	return s.sidecars.awaitSend(ctx, req.Sidecar, req.Surface, req.Cids, func() error {
		return s.sendViewSidecar(ctx, req)
	})
}
