package tests

// Checks the rules for reading a location (docs/spec/installation.md#fetching) with a TLS server that the check owns.
// No external network is used.

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/go/src"
)

// tlsFetcher is a Fetcher that trusts the certificate of the server and uses small limits.
func tlsFetcher(server *httptest.Server) sok.Fetcher {
	transport := server.Client().Transport.(*http.Transport)
	return sok.Fetcher{
		TLS:     &tls.Config{RootCAs: transport.TLSClientConfig.RootCAs},
		Index:   sok.Limit{Bytes: 16, Timeout: time.Second},
		Release: sok.Limit{Bytes: 16, Timeout: time.Second},
	}
}

// contract: fetch.https.reads-a-tls-response
func TestAnHTTPSLocationIsReadOverTLS(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"format":1}`)
	}))
	defer server.Close()
	fetcher := tlsFetcher(server)
	data, err := fetcher.Read(server.URL+"/index.json", fetcher.Index)
	if err != nil || string(data) != `{"format":1}` {
		t.Fatalf("data %q err %v", data, err)
	}
	// A certificate that is not trusted cannot connect.
	_, err = sok.DefaultFetcher.Read(server.URL+"/index.json", fetcher.Index)
	if err == nil || !strings.HasPrefix(err.Error(), server.URL+"/index.json: cannot connect: ") {
		t.Fatalf("untrusted err %v", err)
	}
}

// contract: fetch.https.redirects-only-to-https
func TestRedirectsAreFollowedOnlyToHTTPS(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var hops int
		if _, err := fmt.Sscanf(r.URL.Path, "/hop/%d", &hops); err == nil && hops > 0 {
			http.Redirect(w, r, fmt.Sprintf("/hop/%d", hops-1), http.StatusFound)
			return
		}
		if r.URL.Path == "/plain" {
			http.Redirect(w, r, "http://example.invalid/index.json", http.StatusFound)
			return
		}
		fmt.Fprint(w, "end")
	}))
	defer server.Close()
	fetcher := tlsFetcher(server)
	if data, err := fetcher.Read(server.URL+"/hop/5", fetcher.Index); err != nil || string(data) != "end" {
		t.Fatalf("five redirects: %q %v", data, err)
	}
	if _, err := fetcher.Read(server.URL+"/hop/6", fetcher.Index); err == nil || err.Error() != server.URL+"/hop/6: more than 5 redirects" {
		t.Fatalf("six redirects: %v", err)
	}
	if _, err := fetcher.Read(server.URL+"/plain", fetcher.Index); err == nil || err.Error() != server.URL+"/plain: redirect to http://example.invalid/index.json is not https" {
		t.Fatalf("plain redirect: %v", err)
	}
}

// contract: fetch.https.reports-status-size-and-timeout
func TestStatusSizeAndTimeoutFailWithTheirTexts(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/missing":
			http.NotFound(w, r)
		case "/large":
			fmt.Fprint(w, strings.Repeat("x", 17))
		case "/slow":
			// No answer comes: the time limit of the fetch is the only end of the read, and the client that gives up ends the
			// request.
			<-r.Context().Done()
		default:
			fmt.Fprint(w, strings.Repeat("x", 16))
		}
	}))
	defer server.Close()
	fetcher := tlsFetcher(server)
	cases := map[string]string{
		"/missing": "HTTP 404",
		"/large":   "larger than 16 bytes",
		"/slow":    "timed out after 1 s",
	}
	for path, want := range cases {
		if _, err := fetcher.Read(server.URL+path, fetcher.Release); err == nil || err.Error() != server.URL+path+": "+want {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if data, err := fetcher.Read(server.URL+"/limit", fetcher.Release); err != nil || len(data) != 16 {
		t.Fatalf("limit: %d %v", len(data), err)
	}
}

// contract: fetch.url.rejects-other-schemes
func TestOtherSchemesAreRejected(t *testing.T) {
	for _, location := range []string{"http://example.invalid/index.json", "ftp://example.invalid/index.json", "index.json", "https:index.json"} {
		_, err := sok.DefaultFetcher.Read(location, sok.DefaultFetcher.Index)
		if err == nil || err.Error() != location+": the URL must be https: or an absolute file: URL" {
			t.Fatalf("%s: %v", location, err)
		}
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "index.json")
	if err := os.WriteFile(file, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if data, err := sok.DefaultFetcher.Read("file://"+file, sok.DefaultFetcher.Index); err != nil || string(data) != "{}" {
		t.Fatalf("file: %q %v", data, err)
	}
}

// contract: fetch.https.reads-a-tls-response
func TestRegistryUseRecordsAnHTTPSIndex(t *testing.T) {
	index := `{"format":1,"plugins":[],"sidecars":[],"packs":[],"revoked":{"plugins":[],"sidecars":[]}}`
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, index)
	}))
	defer server.Close()
	fetcher := tlsFetcher(server)
	fetcher.Index.Bytes = 1 << 20
	config := t.TempDir()
	url, err := sok.UseRegistry(config, server.URL+"/index.json", fetcher)
	if err != nil || url != server.URL+"/index.json" {
		t.Fatalf("url %q err %v", url, err)
	}
	if text := readText(t, filepath.Join(config, "plugins/registry.json")); text != `{"format":1,"index":"`+server.URL+`/index.json"}`+"\n" {
		t.Fatalf("registry.json %q", text)
	}
}

// emptyIndex is the smallest registry index that the checks of reading an index serve.
const emptyIndex = `{"format":1,"plugins":[],"sidecars":[],"packs":[],"revoked":{"plugins":[],"sidecars":[]}}`

// indexServer is a TLS server of the check that serves emptyIndex with an ETag and answers a request that sends that ETag
// with 304. It counts the connections, the requests and the bodies that it sent.
type indexServer struct {
	*httptest.Server
	mu                            sync.Mutex
	connections, requests, bodies int
	// arrived receives each request before it is answered, and hold, when set, blocks the answer until it is closed.
	arrived chan struct{}
	hold    chan struct{}
}

func newIndexServer(t *testing.T) *indexServer {
	s := &indexServer{arrived: make(chan struct{}, 16)}
	s.Server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.requests++
		hold := s.hold
		s.mu.Unlock()
		s.arrived <- struct{}{}
		if hold != nil {
			<-hold
		}
		if r.URL.Path == "/unvalidated" {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		if r.Header.Get("If-None-Match") == `"v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		s.mu.Lock()
		s.bodies++
		s.mu.Unlock()
		fmt.Fprint(w, emptyIndex)
	}))
	s.Server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			s.mu.Lock()
			s.connections++
			s.mu.Unlock()
		}
	}
	s.StartTLS()
	t.Cleanup(s.Close)
	return s
}

// counts returns the connections, the requests and the bodies of the server.
func (s *indexServer) counts() (int, int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connections, s.requests, s.bodies
}

// indexFetcher is a fetcher that trusts the server and reads an index of up to 1 MiB.
func indexFetcher(server *indexServer) sok.Fetcher {
	fetcher := tlsFetcher(server.Server)
	fetcher.Index.Bytes = 1 << 20
	return fetcher
}

// contract: fetch.https.reuses-the-connection
func TestReadsOfOneFetcherReuseTheConnection(t *testing.T) {
	server := newIndexServer(t)
	fetcher := indexFetcher(server)
	for range 3 {
		if _, _, err := sok.ReadIndexAt(server.URL+"/index.json", fetcher); err != nil {
			t.Fatal(err)
		}
	}
	if connections, requests, _ := server.counts(); connections != 1 || requests != 3 {
		t.Fatalf("connections %d requests %d, want 1 connection for 3 requests", connections, requests)
	}
}

// contract: fetch.https.answers-an-unchanged-index-without-a-body
func TestAnUnchangedIndexIsAnsweredWithoutABody(t *testing.T) {
	server := newIndexServer(t)
	fetcher := indexFetcher(server)
	for read := range 3 {
		index, _, err := sok.ReadIndexAt(server.URL+"/index.json", fetcher)
		if err != nil || index == nil {
			t.Fatalf("read %d: index %v err %v", read, index, err)
		}
	}
	if _, requests, bodies := server.counts(); requests != 3 || bodies != 1 {
		t.Fatalf("requests %d bodies %d, want 3 requests and 1 body", requests, bodies)
	}
	// A 304 answer to a request that sent no validator is not an index.
	if _, _, err := sok.ReadIndexAt(server.URL+"/unvalidated", fetcher); err == nil || err.Error() != server.URL+"/unvalidated: HTTP 304" {
		t.Fatalf("unvalidated 304: %v", err)
	}
}

// contract: fetch.https.shares-a-running-index-read
func TestAReadThatStartsDuringARunningReadSharesIt(t *testing.T) {
	server := newIndexServer(t)
	hold := make(chan struct{})
	server.mu.Lock()
	server.hold = hold
	server.mu.Unlock()
	fetcher := indexFetcher(server)
	location := server.URL + "/index.json"
	type result struct {
		index *sok.Index
		err   error
	}
	results := make(chan result, 2)
	read := func() {
		index, _, err := sok.ReadIndexAt(location, fetcher)
		results <- result{index, err}
	}
	go read()
	<-server.arrived
	go read()
	// The second read waits for the first: the fetcher reports it before the first answer is released.
	deadline := time.Now().Add(5 * time.Second)
	for sok.IndexReadWaiters(location) != 1 {
		if time.Now().After(deadline) {
			_, requests, _ := server.counts()
			close(hold)
			t.Fatalf("waiters %d requests %d: the second read did not wait for the running read", sok.IndexReadWaiters(location), requests)
		}
		time.Sleep(time.Millisecond)
	}
	close(hold)
	for range 2 {
		if got := <-results; got.err != nil || got.index == nil {
			t.Fatalf("index %v err %v", got.index, got.err)
		}
	}
	if _, requests, bodies := server.counts(); requests != 1 || bodies != 1 {
		t.Fatalf("requests %d bodies %d, want one shared request", requests, bodies)
	}
}
