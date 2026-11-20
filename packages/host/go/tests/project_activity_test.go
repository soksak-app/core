package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// The record of the activities of the projects of the application meets the shared cases records of docs/spec/cases/activity.json
// (docs/spec/activity.md#activity-of-a-project).
// contract: project-activity.record.cases
func TestTheProjectActivityRecordMeetsEachCase(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "spec", "cases", "activity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Records []struct {
			Name  string `json:"name"`
			Steps []struct {
				Publish *struct {
					Window string                        `json:"window"`
					Owner  *string                       `json:"owner"`
					ID     string                        `json:"id"`
					Spaces map[string]host.SpaceActivity `json:"spaces"`
				} `json:"publish"`
				Release *struct {
					ID string `json:"id"`
				} `json:"release"`
				End *struct {
					Window string `json:"window"`
				} `json:"end"`
				Error  *string         `json:"error"`
				Record json.RawMessage `json:"record"`
			} `json:"steps"`
		} `json:"records"`
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Records) == 0 {
		t.Fatal("activity.json holds no case of records")
	}
	for _, kase := range file.Records {
		t.Run(kase.Name, func(t *testing.T) {
			var record host.ProjectActivities
			for index, step := range kase.Steps {
				var err error
				switch {
				case step.Publish != nil:
					owner := ""
					if step.Publish.Owner != nil {
						owner = *step.Publish.Owner
					}
					_, err = record.Publish(step.Publish.Window, owner, step.Publish.ID, step.Publish.Spaces)
				case step.Release != nil:
					record.Release(step.Release.ID)
				default:
					record.End(step.End.Window)
				}
				got, want := "", ""
				if err != nil {
					got = err.Error()
				}
				if step.Error != nil {
					want = *step.Error
				}
				if got != want {
					t.Fatalf("step %d: the error is %q, want %q", index, got, want)
				}
				text, err := json.Marshal(record.Record())
				if err != nil {
					t.Fatal(err)
				}
				var gotValue, wantValue any
				if err := json.Unmarshal(text, &gotValue); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(step.Record, &wantValue); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(gotValue, wantValue) {
					t.Fatalf("step %d: the record is %s, want %s", index, text, step.Record)
				}
			}
		})
	}
}
