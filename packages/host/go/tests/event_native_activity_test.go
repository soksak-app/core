// The registration of the activity observers at the start of a host (docs/spec/logging.md#policy). The observers belong to the
// process and are installed once, so the test runs the start in a child process of its own.
package host_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// activityObserversChild marks the child process that starts the event log of a host: the activity observers belong to the
// process and are installed once, so only a process that no earlier test started shows when they register.
const activityObserversChild = "SOKSAK_ACTIVITY_OBSERVERS_CHILD"

// contract: log.native.activity-observers-register-under-the-policy
// The start of a host installs the activity observers after it applied the policy file, so a policy that stores the class
// lifecycle at the level info stores the registration of each activity observer (docs/spec/logging.md#policy).
func TestTheActivityObserversRegisterUnderThePolicyOfTheHostStart(t *testing.T) {
	if os.Getenv(activityObserversChild) == "" {
		command := exec.Command(os.Args[0], "-test.run", "^TestTheActivityObserversRegisterUnderThePolicyOfTheHostStart$", "-test.count=1")
		command.Env = append(os.Environ(), activityObserversChild+"=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("the child that starts the host ended with %v: %s", err, output)
		}
		return
	}
	config := t.TempDir()
	policy := `{"schema":1,"classes":{"lifecycle":"info","input":"error","call":"error","io":"error","frame":"error"}}`
	if err := os.WriteFile(filepath.Join(config, "log-policy.json"), []byte(policy), 0o600); err != nil {
		t.Fatal(err)
	}
	log, err := host.StartHostEventLog(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	stop, err := host.StartHostLogPolicy(log, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stop)
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	registered := map[string]bool{}
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "native.observe.registered" {
			source, _ := event["fields"].(map[string]any)["source"].(string)
			registered[source] = true
		}
	}
	for _, source := range []string{"activity.window", "activity.occlusion"} {
		if !registered[source] {
			t.Errorf("the log holds no native.observe.registered of %s under a policy that stores it; registered %v", source, registered)
		}
	}
}
