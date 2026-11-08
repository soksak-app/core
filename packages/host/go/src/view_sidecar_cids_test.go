package host

import (
	"encoding/json"
	"testing"
)

// contract: sidecars.view-send.uncorrelated-cids-are-accepted
func TestViewSidecarSendPreservesUncorrelatedCidsCarriers(t *testing.T) {
	for _, suffix := range []string{"", `,"cids":null`, `,"cids":[]`} {
		raw := json.RawMessage(`{"source":"probe","generation":1,"sidecar":"worker","surface":"probe","body":{}` + suffix + `}`)
		request, err := viewSidecarSendRequestFrom(raw)
		if err != nil {
			t.Errorf("ordinary uncorrelated request %s was refused: %v", raw, err)
			continue
		}
		if len(request.Cids) != 0 {
			t.Errorf("uncorrelated request acquired CIDs: %v", request.Cids)
		}
	}
}
