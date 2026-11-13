package host

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

// stallCase is one beat of the watch as data: the state before the beat, its readings and the decision that the beat makes.
type stallCase struct {
	name    string
	state   stallState
	reading stallReading
	want    stallOutcome
}

// stallIdle is the state of a watch with no open stall.
var stallIdle = stallState{stalledFrom: -1}

var stallCases = []stallCase{
	{
		name:    "a beat that answers in time stores nothing",
		state:   stallIdle,
		reading: stallReading{now: 250, last: 200},
		want:    stallOutcome{next: stallIdle},
	},
	{
		name:    "a stall that is 999 ms late is not a stall",
		state:   stallIdle,
		reading: stallReading{now: 999, last: 0, schedule: stallSchedule{priority: 31}},
		want:    stallOutcome{next: stallIdle},
	},
	{
		name:    "a stall found on a late wake of the watch carries the lateness of the watch",
		state:   stallIdle,
		reading: stallReading{now: 1850, last: 0, watchLate: 1600 * time.Millisecond, schedule: stallSchedule{priority: 31}},
		want: stallOutcome{
			next: stallState{stalledFrom: 0, cpuKnown: true}, starts: true, record: "host.stall", level: LevelWarn,
			fields: map[string]any{"late_ms": int64(1850), "watch_late_ms": int64(1600), "priority": int64(31)},
		},
	},
	{
		name:    "a stall of a blocked main thread has no lateness of the watch",
		state:   stallIdle,
		reading: stallReading{now: 1000, last: 0, schedule: stallSchedule{priority: 31}},
		want: stallOutcome{
			next: stallState{stalledFrom: 0, cpuKnown: true}, starts: true, record: "host.stall", level: LevelWarn,
			fields: map[string]any{"late_ms": int64(1000), "watch_late_ms": int64(0), "priority": int64(31)},
		},
	},
	{
		name:    "a stall of a background process carries its priority and the CPU time it starts from",
		state:   stallIdle,
		reading: stallReading{now: 1000, last: 0, schedule: stallSchedule{priority: 4, cpu: uint64(100 * time.Millisecond)}},
		want: stallOutcome{
			next: stallState{stalledFrom: 0, cpu: uint64(100 * time.Millisecond), cpuKnown: true}, starts: true,
			record: "host.stall", level: LevelWarn,
			fields: map[string]any{"late_ms": int64(1000), "watch_late_ms": int64(0), "priority": int64(4)},
		},
	},
	{
		name:  "a stall whose schedule cannot be read leaves out the priority and the CPU time",
		state: stallIdle,
		reading: stallReading{now: 1000, last: 0,
			schedule: stallSchedule{err: errors.New("process schedule: errno 3")}},
		want: stallOutcome{
			next: stallState{stalledFrom: 0}, starts: true, record: "host.stall", level: LevelWarn,
			fields:      map[string]any{"late_ms": int64(1000), "watch_late_ms": int64(0)},
			scheduleErr: errors.New("process schedule: errno 3"),
		},
	},
	{
		name:    "an open stall that did not move stores nothing",
		state:   stallState{stalledFrom: 500, cpu: uint64(100 * time.Millisecond), cpuKnown: true},
		reading: stallReading{now: 2000, last: 500},
		want:    stallOutcome{next: stallState{stalledFrom: 500, cpu: uint64(100 * time.Millisecond), cpuKnown: true}},
	},
	{
		name:    "the end of a stall reports its length and the CPU time since its start",
		state:   stallState{stalledFrom: 500, cpu: uint64(100 * time.Millisecond), cpuKnown: true},
		reading: stallReading{now: 1750, last: 1750, schedule: stallSchedule{priority: 4, cpu: uint64(130 * time.Millisecond)}},
		want: stallOutcome{
			next:   stallState{stalledFrom: -1, cpu: uint64(100 * time.Millisecond), cpuKnown: true},
			record: "host.stall.resumed", level: LevelInfo,
			fields: map[string]any{"stalled_ms": int64(1250), "cpu_ms": int64(30)},
		},
	},
	{
		name:    "the end of a stall whose start had no CPU reading reports no CPU time",
		state:   stallState{stalledFrom: 500},
		reading: stallReading{now: 1750, last: 1750, schedule: stallSchedule{priority: 4, cpu: uint64(130 * time.Millisecond)}},
		want: stallOutcome{
			next: stallState{stalledFrom: -1}, record: "host.stall.resumed", level: LevelInfo,
			fields: map[string]any{"stalled_ms": int64(1250)},
		},
	},
	{
		name:  "the end of a stall whose schedule cannot be read reports its length without CPU time",
		state: stallState{stalledFrom: 500, cpu: uint64(100 * time.Millisecond), cpuKnown: true},
		reading: stallReading{now: 1750, last: 1750,
			schedule: stallSchedule{err: errors.New("process schedule: errno 3")}},
		want: stallOutcome{
			next:   stallState{stalledFrom: -1, cpu: uint64(100 * time.Millisecond), cpuKnown: true},
			record: "host.stall.resumed", level: LevelInfo,
			fields:      map[string]any{"stalled_ms": int64(1250)},
			scheduleErr: errors.New("process schedule: errno 3"),
		},
	},
}

// contract: host.stall.watch-late-separates-scheduling, host.stall.watch-late-separates-blocked-main, host.stall.carries-priority, host.stall.resumed-carries-cpu
func TestStallStepDecidesEachBeatFromItsReadings(t *testing.T) {
	for _, c := range stallCases {
		t.Run(c.name, func(t *testing.T) {
			got := stallStep(c.state, c.reading)
			if got.next != c.want.next {
				t.Fatalf("next state %+v, want %+v", got.next, c.want.next)
			}
			if got.starts != c.want.starts {
				t.Fatalf("starts %v, want %v", got.starts, c.want.starts)
			}
			if got.record != c.want.record {
				t.Fatalf("record %q, want %q", got.record, c.want.record)
			}
			if got.level != c.want.level {
				t.Fatalf("level %v, want %v", got.level, c.want.level)
			}
			if !reflect.DeepEqual(got.fields, c.want.fields) {
				t.Fatalf("fields %v, want %v", got.fields, c.want.fields)
			}
			if (got.scheduleErr == nil) != (c.want.scheduleErr == nil) ||
				(got.scheduleErr != nil && got.scheduleErr.Error() != c.want.scheduleErr.Error()) {
				t.Fatalf("schedule error %v, want %v", got.scheduleErr, c.want.scheduleErr)
			}
		})
	}
}
