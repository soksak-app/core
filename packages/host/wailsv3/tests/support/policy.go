package support

import (
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// StoreEveryLevel puts the policy that stores every level of every class in force in the writer. The default policy stores only
// errors, so a test that checks an event below error gives its writer this policy first; the policy is recorded with the event
// `log.policy`.
func StoreEveryLevel(t *testing.T, log *host.EventLog) {
	t.Helper()
	policy, err := host.ParseLogPolicy("every level", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
}
