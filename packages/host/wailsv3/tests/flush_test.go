package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// TestEveryPendingReplyIsFlushedAfterTheQueueDrains 는 쓰기 queue 가 가득 찼을 때 버퍼링된
// 모든 reply 와 close 가 queue 를 비운 뒤 올바른 순서로 기록되는지 검증한다.
// contract: flush.queue.rejects-send-when-full, flush.queue.full-error-says-not-keeping-up, flush.buffer.replies-delivered-after-drain, flush.buffer.closes-delivered-after-drain, flush.buffer.consumed-acks-not-coalesced, flush.buffer.delivered-after-queued-bodies
func TestEveryPendingReplyIsFlushedAfterTheQueueDrains(t *testing.T) {
	directory := t.TempDir()
	fifo := filepath.Join(directory, "go")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	received := filepath.Join(directory, "received")
	// 사이드카는 FIFO 를 읽기로 여는 순간 블록한다. 그동안 stdin 을 읽지 않는다. 폴링이 아니다.
	script := "#!/bin/sh\nread _ < " + fifo + "\nexec cat > " + received + "\n"
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(frontend(`{"executable":"build/echo","protocol":1}`), directory, directory)
	if err != nil {
		t.Fatal(err)
	}
	owner := newFakeOwner("/p")
	// 닫을 표면을 먼저 등록한다(Close 는 등록된 표면만 알린다).
	for _, s := range []string{"s1", "s2", "s3"} {
		if err := sidecars.Send(owner, echoSidecar, s, json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	// 큐와 파이프 버퍼를 가득 채운다.
	big := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	full := false
	for i := 0; i < 4000 && !full; i++ {
		if err := sidecars.Send(owner, echoSidecar, "s1", big); err != nil {
			if !strings.Contains(err.Error(), "is not keeping up") {
				t.Fatal(err)
			}
			full = true
		}
	}
	if !full {
		t.Fatal("the queue never filled")
	}
	// 가득 찬 상태에서 표면·이름이 다른 반납 셋과 닫힘 둘.
	for i, name := range []string{"a", "b", "c"} {
		bodyMap := host.AfterPresent(true, "", name, 1, 1, i+1)
		bodyBytes, _ := json.Marshal(bodyMap)
		if err := sidecars.SendResponse(echoSidecar, "s1", name, json.RawMessage(bodyBytes)); err != nil {
			t.Fatal(err)
		}
	}
	// 같은 그림 a 에 다른 sequence 로 다시 보낸다. immutable frame ack는 모두 도착해야 한다.
	bodyMap := host.AfterPresent(true, "", "a", 1, 1, 4)
	bodyBytes, _ := json.Marshal(bodyMap)
	if err := sidecars.SendResponse(echoSidecar, "s1", "a", json.RawMessage(bodyBytes)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s2")
	sidecars.Close("s3")
	// 사이드카를 풀어 준다. 그 뒤로 아무것도 더 보내지 않는다.
	f, err := os.OpenFile(fifo, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("go\n"))
	f.Close()
	sidecars.Stop() // 큐와 보관분을 모두 쓴 뒤 stdin 을 닫는다. cat 이 끝난다.
	data, err := os.ReadFile(received)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{`"name":"a"`, `"name":"b"`, `"name":"c"`} {
		if !strings.Contains(text, want) {
			t.Errorf("reply %s never reached the sidecar", want)
		}
	}
	for _, s := range []string{`"surface":"s2","root":"/p","closed":true`, `"surface":"s3","root":"/p","closed":true`} {
		if !strings.Contains(text, s) {
			t.Errorf("close %s never reached the sidecar", s)
		}
	}
	// 실제 JSON 필드 순서는 Marshal 결과를 기반으로 함. 각 immutable frame ack가
	// 정확히 한 번씩 도착해야 하며, 같은 image의 새 sequence가 이전 frame을 덮어쓰지 않는다.
	for _, pattern := range []string{
		`"name":"a","raster":1,"sequence":1`,
		`"name":"b","raster":1,"sequence":2`,
		`"name":"c","raster":1,"sequence":3`,
		`"name":"a","raster":1,"sequence":4`,
	} {
		if count := strings.Count(text, pattern); count != 1 {
			t.Errorf("image frame %s should appear exactly once, appeared %d times", pattern, count)
		}
	}

	// 순서: 닫힘과 반납은 큐에 먼저 들어간 큰 본문들보다 뒤에 온다.
	last := strings.LastIndex(text, `"data":"`)
	if last < 0 {
		t.Fatal("no queued body arrived")
	}
	for _, want := range []string{`"name":"a"`, `"surface":"s2","root":"/p","closed":true`} {
		switch i := strings.Index(text, want); {
		case i < 0:
			t.Errorf("%s did not arrive", want)
		case i < last:
			t.Errorf("%s arrived before the queued bodies", want)
		}
	}
}

// TestOrderIsCorrectWhenStopFlushesBufferedMessages 는 Stop() 이 stdin 을 닫기 전에
// 버퍼링된 모든 메시지를 기록하여 메시지를 잃지 않는지 검증한다.
// contract: flush.queue.rejects-send-when-full, flush.queue.full-error-says-not-keeping-up, flush.buffer.replies-delivered-after-drain, flush.buffer.closes-delivered-after-drain
func TestOrderIsCorrectWhenStopFlushesBufferedMessages(t *testing.T) {
	directory := t.TempDir()
	fifo := filepath.Join(directory, "go")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	received := filepath.Join(directory, "received")
	script := "#!/bin/sh\nread _ < " + fifo + "\nexec cat > " + received + "\n"
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(frontend(`{"executable":"build/echo","protocol":1}`), directory, directory)
	if err != nil {
		t.Fatal(err)
	}
	sidecars.StopTimeout = 10 * time.Second // Stop() 이 cat 이 5MB 를 받을 만큼 충분히 기다리게 한다
	owner := newFakeOwner("/p")

	// 표면 등록
	for _, s := range []string{"s1", "s2"} {
		if err := sidecars.Send(owner, echoSidecar, s, json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}

	// 큐를 가득 채운다.
	big := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	full := false
	for i := 0; i < 4000 && !full; i++ {
		if err := sidecars.Send(owner, echoSidecar, "s1", big); err != nil {
			if !strings.Contains(err.Error(), "is not keeping up") {
				t.Fatal(err)
			}
			full = true
		}
	}
	if !full {
		t.Fatal("the queue never filled")
	}

	// 가득 찬 상태에서 보관할 메시지들
	for i, name := range []string{"x", "y", "z"} {
		bodyMap := host.AfterPresent(true, "", name, 1, 1, i+1)
		bodyBytes, _ := json.Marshal(bodyMap)
		if err := sidecars.SendResponse(echoSidecar, "s1", name, json.RawMessage(bodyBytes)); err != nil {
			t.Fatal(err)
		}
	}
	sidecars.Close("s2")

	// 사이드카를 풀어 준다.
	f, err := os.OpenFile(fifo, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("go\n"))
	f.Close()

	// Stop() 을 호출하면 보관분을 모두 쓴 뒤 stdin 을 닫아야 한다.
	sidecars.Stop()

	data, err := os.ReadFile(received)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)

	// 모든 보관 메시지가 도착했는지 확인
	for _, want := range []string{`"name":"x"`, `"name":"y"`, `"name":"z"`, `"surface":"s2","root":"/p","closed":true`} {
		if !strings.Contains(text, want) {
			t.Errorf("buffered message %s was lost", want)
		}
	}
}
