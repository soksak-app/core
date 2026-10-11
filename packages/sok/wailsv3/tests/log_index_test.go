package tests

// The index beside an event file (docs/spec/logging.md#index): its bytes for the golden files, its follow of appended lines, its rebuild of a
// file that is not the one it indexed, its refusal of damage, and its move with the generations of a rotation.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

const (
	stateBlockBytes = 20480
	recordBytes     = 18760
)

func digestOf(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type digests struct {
	Logs map[string]string `json:"logs"`
	Big  struct {
		Source string `json:"source"`
		Index  string `json:"index"`
	} `json:"big"`
}

func readDigests(t *testing.T) digests {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(queryFixtures, "digests.json"))
	if err != nil {
		t.Fatal(err)
	}
	var d digests
	if err := json.Unmarshal(data, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

// contract: log.index.matches-the-golden-digest
func TestLogIndexMatchesTheGoldenDigest(t *testing.T) {
	want := readDigests(t)
	config := fixtureConfig(t)
	if len(want.Logs) != 5 {
		t.Fatalf("the golden digests hold %d files", len(want.Logs))
	}
	for name, digest := range want.Logs {
		path := filepath.Join(config, "logs", name)
		update, err := sok.UpdateLogIndex(path)
		if err != nil || !update.Changed || !update.Rebuilt {
			t.Fatalf("%s: update %+v err %v", name, update, err)
		}
		if got := digestOf(t, path+".idx"); got != digest {
			t.Errorf("%s: the index has the digest %s, the golden digest is %s", name, got, digest)
		}
		again, err := sok.UpdateLogIndex(path)
		if err != nil || again.Changed {
			t.Errorf("%s: an update of a current index changed it: %+v err %v", name, again, err)
		}
		if got := digestOf(t, path+".idx"); got != digest {
			t.Errorf("%s: an update of a current index changed its digest to %s", name, got)
		}
	}
	_, path, _ := writeBig(t)
	if got := digestOf(t, path); got != want.Big.Source {
		t.Fatalf("the generated log has the digest %s, the golden digest is %s", got, want.Big.Source)
	}
	if _, err := sok.UpdateLogIndex(path); err != nil {
		t.Fatal(err)
	}
	if got := digestOf(t, path+".idx"); got != want.Big.Index {
		t.Errorf("the index of the generated log has the digest %s, the golden digest is %s", got, want.Big.Index)
	}
	info, err := sok.ReadLogIndex(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Events != bigCount || info.FullSegments != 2 || info.TailEvents != bigCount-2*4096 || info.FirstSeq != 1 || info.LastSeq != bigCount {
		t.Errorf("the index of the generated log is %+v", info)
	}
}

func eventLineOf(seq int) string {
	if seq == 1 {
		return `{"ts_us":1000,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"log.open","fields":{"schema":2,"pid":1,"role":"host","boot":"a"}}`
	}
	return fmt.Sprintf(`{"ts_us":%d,"mono_ns":%d,"seq":%d,"level":"debug","layer":"host","event":"host.x.y","fields":{"n":%d}}`, 1000+seq, seq, seq, seq)
}

func linesOf(from, to int) string {
	var b strings.Builder
	for seq := from; seq <= to; seq++ {
		b.WriteString(eventLineOf(seq))
		b.WriteByte('\n')
	}
	return b.String()
}

// contract: log.index.follows-appended-lines-and-is-rebuilt-when-stale
func TestLogIndexFollowsAppendedLinesAndIsRebuiltWhenStale(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host-a.jsonl")
	complete := linesOf(1, 4)
	partial := eventLineOf(5)
	if err := os.WriteFile(path, []byte(complete+partial[:20]), 0o644); err != nil {
		t.Fatal(err)
	}
	update, err := sok.UpdateLogIndex(path)
	if err != nil || !update.Changed || !update.Rebuilt || update.Reason != "the index did not exist" {
		t.Fatalf("first update %+v err %v", update, err)
	}
	info, err := sok.ReadLogIndex(path)
	if err != nil || info.Events != 4 || info.IndexedBytes != int64(len(complete)) || info.FullSegments != 0 || info.TailEvents != 4 {
		t.Fatalf("after the first update %+v err %v: the bytes after the last line feed must not be indexed", info, err)
	}

	// The line is finished and 5,000 lines follow: the update indexes from the partial segment on.
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(partial[20:] + "\n" + linesOf(6, 5005)); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	update, err = sok.UpdateLogIndex(path)
	if err != nil || !update.Changed || update.Rebuilt {
		t.Fatalf("append update %+v err %v: the appended lines must be indexed without a rebuild", update, err)
	}
	info, err = sok.ReadLogIndex(path)
	if err != nil || info.Events != 5005 || info.FullSegments != 1 || info.TailEvents != 5005-4096 || info.LastSeq != 5005 {
		t.Fatalf("after the append %+v err %v", info, err)
	}

	// The same size with another modification time is not the file that was indexed.
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
	update, err = sok.UpdateLogIndex(path)
	if err != nil || !update.Rebuilt || update.Reason != "the modification time changed at the same size" {
		t.Fatalf("modification time update %+v err %v", update, err)
	}

	// A smaller file.
	if err := os.WriteFile(path, []byte(linesOf(1, 10)), 0o644); err != nil {
		t.Fatal(err)
	}
	update, err = sok.UpdateLogIndex(path)
	if err != nil || !update.Rebuilt || update.Reason != "the file is smaller than the indexed part" {
		t.Fatalf("smaller update %+v err %v", update, err)
	}
	if info, err = sok.ReadLogIndex(path); err != nil || info.Events != 10 {
		t.Fatalf("after the smaller file %+v err %v", info, err)
	}

	// Another first line in a larger file.
	other := strings.Replace(linesOf(1, 40), `"boot":"a"`, `"boot":"b"`, 1)
	if err := os.WriteFile(path, []byte(other), 0o644); err != nil {
		t.Fatal(err)
	}
	update, err = sok.UpdateLogIndex(path)
	if err != nil || !update.Rebuilt || update.Reason != "the first line changed" {
		t.Fatalf("first line update %+v err %v", update, err)
	}
	if info, err = sok.ReadLogIndex(path); err != nil || info.Events != 40 {
		t.Fatalf("after the other first line %+v err %v", info, err)
	}
}

// contract: log.index.counts-the-lines-that-announce-a-change
func TestLogIndexCountsTheLinesThatAnnounceAChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host-a.jsonl")
	read := func(seq int, event, name string) string {
		return fmt.Sprintf(`{"ts_us":%d,"mono_ns":%d,"seq":%d,"level":"debug","layer":"host","event":%q,"fields":{"name":%q}}`+"\n", 1000+seq, seq, seq, event, name)
	}
	other := func(seq int) string { return eventLineOf(seq) + "\n" }
	first := eventLineOf(1) + "\n" + read(2, "host.binding.call", "logQuery") + read(3, "host.endpoint.call", "log.query") + other(4)
	if err := os.WriteFile(path, []byte(first), 0o644); err != nil {
		t.Fatal(err)
	}
	update, err := sok.UpdateLogIndex(path)
	if err != nil || update.Lines != 4 || update.Announcing != 2 || update.Size != int64(len(first)) {
		t.Fatalf("first update %+v err %v: the records of the two calls that read the log do not announce a change, log.open and the other event do", update, err)
	}
	// A call with the same name in another event, and another call in the same event, announce a change.
	second := read(5, "host.binding.call", "logQuery") + read(6, "host.binding.call", "debugFiles") + read(7, "page.call", "logQuery")
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(second); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	update, err = sok.UpdateLogIndex(path)
	if err != nil || update.Announcing != 2 || update.Size != int64(len(first)+len(second)) {
		t.Fatalf("second update %+v err %v", update, err)
	}
	// An update of a current index announces nothing.
	if update, err = sok.UpdateLogIndex(path); err != nil || update.Changed || update.Announcing != 0 || update.Size != int64(len(first)+len(second)) {
		t.Fatalf("current update %+v err %v", update, err)
	}
}

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// contract: log.index.refuses-a-damaged-index-and-a-broken-line
func TestLogIndexRefusesADamagedIndexAndABrokenLine(t *testing.T) {
	_, path, _ := writeBig(t)
	if _, err := sok.UpdateLogIndex(path); err != nil {
		t.Fatal(err)
	}
	name := "logs/host-big.jsonl.idx"
	original, err := os.ReadFile(path + ".idx")
	if err != nil {
		t.Fatal(err)
	}
	damage := func(change func(data []byte) []byte) error {
		data := change(append([]byte(nil), original...))
		writeFile(t, path+".idx", string(data))
		_, err := sok.UpdateLogIndex(path)
		return err
	}
	cases := []struct {
		name   string
		change func(data []byte) []byte
		want   string
	}{
		{"version", func(data []byte) []byte {
			data[stateBlockBytes+4] = 2
			return data
		}, name + ": version 2 is not 1"},
		{"state checksum", func(data []byte) []byte {
			data[stateBlockBytes+100] ^= 0xff
			return data
		}, name + ": neither state block has a valid checksum"},
		{"shorter than the blocks", func(data []byte) []byte { return data[:100] }, name + ": 100 bytes are fewer than the two state blocks of 40960"},
		{"fewer records than the block", func(data []byte) []byte { return data[:2*stateBlockBytes+recordBytes] }, name + ": 1 records follow the state blocks, and the state block counts 2"},
	}
	for _, c := range cases {
		if err := damage(c.change); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error %v, want %q", c.name, err, c.want)
		}
	}

	// A record whose checksum does not match is found when a query reads it.
	writeFile(t, path+".idx", string(original))
	broken := append([]byte(nil), original...)
	broken[2*stateBlockBytes+100] ^= 0xff
	writeFile(t, path+".idx", string(broken))
	query, err := sok.ParseLogQuery([]byte(`{"cid":"c500"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sok.QueryLogs(filepath.Dir(filepath.Dir(path)), query, nil); err == nil || !strings.Contains(err.Error(), name+": segment 0 has a record whose checksum does not match") {
		t.Errorf("record checksum: error %v", err)
	}
	writeFile(t, path+".idx", string(original))

	// A source that breaks the structure stops the update and the index keeps its earlier state.
	good := filepath.Join(t.TempDir(), "host-g.jsonl")
	writeFile(t, good, linesOf(1, 10))
	if _, err := sok.UpdateLogIndex(good); err != nil {
		t.Fatal(err)
	}
	before := digestOf(t, good+".idx")
	file, err := os.OpenFile(good, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(eventLineOf(11) + "\nnot json\n" + eventLineOf(13) + "\n"); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := sok.UpdateLogIndex(good); err == nil || !strings.Contains(err.Error(), "logs/host-g.jsonl:12: not JSON: not json") {
		t.Errorf("broken line: error %v", err)
	}
	if after := digestOf(t, good+".idx"); after != before {
		t.Errorf("a failed update changed the index")
	}
	if info, err := sok.ReadLogIndex(good); err != nil || info.Events != 10 {
		t.Errorf("a failed update left %+v err %v", info, err)
	}

	first := []struct{ name, text, want string }{
		{"first line", `{"ts_us":1,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"host.x"}` + "\n", `logs/host-f.jsonl: the first line is not log.open: "host.x"`},
		{"schema", `{"ts_us":1,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"log.open","fields":{"schema":1}}` + "\n", "logs/host-f.jsonl: schema 1 is not 2"},
		{"layer", linesOf(1, 1) + `{"ts_us":1,"mono_ns":1,"seq":2,"level":"info","layer":"x","event":"a"}` + "\n", `logs/host-f.jsonl:2: layer "x" is not one of native, host, page, plugin, sidecar, sok`},
		{"null surface", linesOf(1, 1) + `{"ts_us":1,"mono_ns":1,"seq":2,"level":"info","layer":"host","event":"a","surface":null}` + "\n", "logs/host-f.jsonl:2: surface must be a string, found null"},
		{"null cids", linesOf(1, 1) + `{"ts_us":1,"mono_ns":1,"seq":2,"level":"info","layer":"host","event":"a","cids":null}` + "\n", "logs/host-f.jsonl:2: cids must be an array of strings, found null"},
		{"null class", linesOf(1, 1) + `{"ts_us":1,"mono_ns":1,"seq":2,"level":"info","layer":"host","event":"a","class":null}` + "\n", "logs/host-f.jsonl:2: class null is not one of lifecycle, input, call, io, frame"},
		{"null fields", linesOf(1, 1) + `{"ts_us":1,"mono_ns":1,"seq":2,"level":"info","layer":"host","event":"a","fields":null}` + "\n", "logs/host-f.jsonl:2: fields must be an object, found null"},
		{"numeric window", linesOf(1, 1) + `{"ts_us":1,"mono_ns":1,"seq":2,"level":"info","layer":"host","event":"a","window":4}` + "\n", "logs/host-f.jsonl:2: window must be a string, found 4"},
		{"class", linesOf(1, 1) + `{"ts_us":1,"mono_ns":1,"seq":2,"level":"info","layer":"host","event":"a","class":"loud"}` + "\n", `logs/host-f.jsonl:2: class "loud" is not one of lifecycle, input, call, io, frame`},
	}
	for _, c := range first {
		target := filepath.Join(t.TempDir(), "host-f.jsonl")
		writeFile(t, target, c.text)
		if _, err := sok.UpdateLogIndex(target); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error %v, want %q", c.name, err, c.want)
		}
		if _, err := os.Stat(target + ".idx"); err == nil {
			// An index that was created for a file that failed holds no state block.
			if _, err := sok.ReadLogIndex(target); err == nil {
				t.Errorf("%s: the failed update left a readable index", c.name)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}

// contract: log.index.moves-with-the-generations-of-a-rotation
func TestLogIndexMovesWithTheGenerationsOfARotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "host-r.jsonl")
	generation := func(n int) string { return fmt.Sprintf("%s.%d", path, n) }
	// rotateTo is the rotation of the writer: the file becomes generation n and a new file starts. No generation is removed or renamed.
	rotateTo := func(n int) func() error {
		return func() error {
			if err := os.Rename(path, generation(n)); err != nil {
				return err
			}
			return os.WriteFile(path, []byte(linesOf(1, 3)), 0o644)
		}
	}
	writeFile(t, path, linesOf(1, 7))
	if _, err := sok.UpdateLogIndex(path); err != nil {
		t.Fatal(err)
	}
	// Lines are appended and the index is not brought up to date before the rotation: the rotation does it.
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(linesOf(8, 12)); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := sok.RotateLogIndexes(path, 1, rotateTo(1)); err != nil {
		t.Fatal(err)
	}
	info, err := sok.ReadLogIndex(generation(1))
	if err != nil || info.Events != 12 || info.LastSeq != 12 {
		t.Fatalf("the closed generation answers from its index: %+v err %v", info, err)
	}
	if _, err := os.Stat(path + ".idx"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the index of the new file must not exist yet: %v", err)
	}
	if update, err := sok.UpdateLogIndex(generation(1)); err != nil || update.Changed {
		t.Errorf("the closed generation is current without a build: %+v err %v", update, err)
	}
	// A second rotation closes generation 2 and leaves generation 1 and its index where they are.
	if _, err := sok.UpdateLogIndex(path); err != nil {
		t.Fatal(err)
	}
	if err := sok.RotateLogIndexes(path, 2, rotateTo(2)); err != nil {
		t.Fatal(err)
	}
	if info, err := sok.ReadLogIndex(generation(1)); err != nil || info.Events != 12 {
		t.Errorf("generation 1 %+v err %v", info, err)
	}
	if info, err := sok.ReadLogIndex(generation(2)); err != nil || info.Events != 3 {
		t.Errorf("generation 2 %+v err %v", info, err)
	}
	// An index that cannot be brought up to date does not stop the rotation of the file: the file and its index file move, and the
	// error says that the index of the closed file is not complete.
	if _, err := sok.UpdateLogIndex(path); err != nil {
		t.Fatal(err)
	}
	broken, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broken.WriteString("not json\n"); err != nil {
		t.Fatal(err)
	}
	if err := broken.Close(); err != nil {
		t.Fatal(err)
	}
	err = sok.RotateLogIndexes(path, 3, rotateTo(3))
	if err == nil || !strings.Contains(err.Error(), "the index of the closed file is not complete: logs/host-r.jsonl:4: not JSON: not json") {
		t.Fatalf("a rotation with a broken line: %v", err)
	}
	if info, err := sok.ReadLogIndex(generation(3)); err != nil || info.Events != 3 {
		t.Errorf("the index of the closed file moved with it: %+v err %v", info, err)
	}
	if info, err := sok.ReadLogIndex(generation(2)); err != nil || info.Events != 3 {
		t.Errorf("the index of the earlier generation stayed: %+v err %v", info, err)
	}
	// A rotation that fails leaves the index files where they are.
	if err := os.WriteFile(path, []byte(linesOf(1, 3)), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := sok.UpdateLogIndex(path); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("rename refused")
	if err := sok.RotateLogIndexes(path, 4, func() error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("rotation error %v", err)
	}
	if _, err := os.Stat(path + ".idx"); err != nil {
		t.Errorf("a failed rotation moved the index: %v", err)
	}
}
