package host

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"testing"
)

// contract: images.generation.increases-across-windows
// A persistent supplier keeps the generation of a surface, and a surface moves between windows, so the windows of one
// process issue the generations of their image attachments from one counter (docs/spec/surface-composition.md).
func TestTheWindowsOfAProcessIssueIncreasingImageGenerations(t *testing.T) {
	first, second := NewImages(), NewImages()
	moved := "tab-moved"
	before := first.BeginGeneration(moved)
	after := second.BeginGeneration(moved)
	reserved := ImageKey{Surface: "tab-reserved", Name: "view"}
	if err := second.Reserve(reserved, &ImageOwner{SidecarName: "vt", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	state, ok := second.states[reserved]
	if !ok {
		t.Fatal("the reserved region has no raster state")
	}
	if !(before < after && after < state.Generation) {
		t.Fatalf("the generations of the second window are %d and %d after %d of the first window, want each greater than the one before",
			after, state.Generation, before)
	}
}

// contract: images.generation.increases-across-restarts
// A persistent supplier outlives the application process, so the first generation of a later process is greater than
// every generation of an earlier process of the same boot, also after a burst of generations (docs/spec/surface-composition.md).
// The later process is a child run of this test binary.
func TestALaterProcessIssuesGreaterImageGenerationsThanAnEarlierOne(t *testing.T) {
	if os.Getenv("SOKSAK_IMAGE_GENERATION_CHILD") != "" {
		fmt.Printf("generation=%d\n", NewImages().BeginGeneration("tab-restored"))
		return
	}
	images := NewImages()
	var last uint64
	for index := range 1000 {
		next := images.BeginGeneration(fmt.Sprintf("tab-%d", index))
		if next <= last {
			t.Fatalf("the earlier process issued %d after %d", next, last)
		}
		last = next
	}
	child := exec.Command(os.Args[0], "-test.run=^TestALaterProcessIssuesGreaterImageGenerationsThanAnEarlierOne$", "-test.count=1")
	child.Env = append(os.Environ(), "SOKSAK_IMAGE_GENERATION_CHILD=1")
	output, err := child.Output()
	if err != nil {
		t.Fatalf("the later process ended with %v: %s", err, output)
	}
	printed := regexp.MustCompile(`(?m)^generation=(\d+)$`).FindStringSubmatch(string(output))
	if printed == nil {
		t.Fatalf("the later process printed no generation: %s", output)
	}
	first, err := strconv.ParseUint(printed[1], 10, 64)
	if err != nil {
		t.Fatalf("the later process printed %q: %v", output, err)
	}
	if first <= last {
		t.Fatalf("the later process issued %d first, want more than %d of the earlier process", first, last)
	}
}
