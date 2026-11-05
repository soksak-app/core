package adapter

import (
	"testing"

	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
)

func TestAStepRecordCarriesTheNamesOfTheEventLog(t *testing.T) {
	for kind, want := range map[mygo.StepKind]string{mygo.StepSelector: "selector", mygo.StepBlock: "block", mygo.StepCallback: "callback"} {
		got := stepRecord(mygo.StepRecord{Kind: kind, Callback: "hitTest:", Entry: 1, Return: 2, Forwarded: 3, Wait: 4}, "main")
		if want := (host.StepRecord{Window: "main", Kind: want, Callback: "hitTest:", Entry: 1, Return: 2, Forwarded: 3, Wait: 4}); got != want {
			t.Fatalf("the record is %+v, want %+v", got, want)
		}
	}
}

func TestRecordStepsEndsWhenItsStopReturns(t *testing.T) {
	stop := (&Framework{}).RecordSteps(func(host.StepRecord) {}, func(uint64) {})
	stop()
}
