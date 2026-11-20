package sok

// Reads registry indexes and releases from a location (docs/spec/installation.md#fetching). A location is an https: URL
// or an absolute file: URL. https: uses TLS with the certificate authorities that the operating system trusts, follows
// redirects only to https: and at most 5 times, and rejects a response other than 200, a body larger than the limit and
// a request slower than the limit with the specified sentence. The process reads through one client for each trust
// configuration, which keeps its connections open, and keeps in memory the last body of each index URL with its
// validators, so an unchanged index is answered with 304 and no body. Nothing is written to disk.

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Limit is the limit of the body size and the time of one request.
type Limit struct {
	Bytes   int64
	Timeout time.Duration
}

// Fetcher reads a location. When TLS is nil, it uses the certificate authorities that the operating system trusts. A
// check gives it its own certificate authority and small limits.
type Fetcher struct {
	TLS     *tls.Config
	Index   Limit
	Release Limit
}

// maxRedirects is the maximum number of redirects that are followed.
const maxRedirects = 5

// DefaultFetcher is the Fetcher that uses the limits of the specification.
var DefaultFetcher = Fetcher{
	Index:   Limit{Bytes: 8 << 20, Timeout: 60 * time.Second},
	Release: Limit{Bytes: 256 << 20, Timeout: 600 * time.Second},
}

// errRedirect is a redirect that cannot be followed. Its sentence becomes the error unchanged.
type errRedirect struct{ text string }

func (e errRedirect) Error() string { return e.text }

// CheckLocation checks that the location is an https: URL or an absolute file: URL.
func CheckLocation(location string) error {
	if strings.HasPrefix(location, "https:") {
		parsed, err := url.Parse(location)
		if err != nil || parsed.Host == "" || parsed.Scheme != "https" {
			return fmt.Errorf("%s: the URL must be https: or an absolute file: URL", location)
		}
		return nil
	}
	if strings.HasPrefix(location, "file:") {
		if _, err := FilePath(location); err != nil {
			return fmt.Errorf("%s: %w", location, err)
		}
		return nil
	}
	return fmt.Errorf("%s: the URL must be https: or an absolute file: URL", location)
}

// Read reads the body of the location within limit.
func (f Fetcher) Read(location string, limit Limit) ([]byte, error) {
	if err := CheckLocation(location); err != nil {
		return nil, err
	}
	if strings.HasPrefix(location, "file:") {
		path, err := FilePath(location)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", location, err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fileError(path, err)
		}
		return data, nil
	}
	return f.get(location, limit, false, nil)
}

// ReadIndex reads the body of the registry index at location within the index limit. An https: read sends the validators
// of the last 200 answer of location and takes the kept body for the answer 304, and a read that starts while a read of
// location runs waits for that read and returns its result (docs/spec/installation.md#fetching).
func (f Fetcher) ReadIndex(location string) ([]byte, error) {
	if err := CheckLocation(location); err != nil {
		return nil, err
	}
	if strings.HasPrefix(location, "file:") {
		return f.Read(location, f.Index)
	}
	fetching.mu.Lock()
	if running := fetching.flights[location]; running != nil {
		running.waiters++
		fetching.mu.Unlock()
		<-running.done
		return running.data, running.err
	}
	running := &indexFlight{done: make(chan struct{})}
	fetching.flights[location] = running
	kept, known := fetching.kept[location]
	fetching.mu.Unlock()
	var validators *keptIndex
	if known {
		validators = &kept
	}
	running.data, running.err = f.get(location, f.Index, true, validators)
	fetching.mu.Lock()
	delete(fetching.flights, location)
	fetching.mu.Unlock()
	close(running.done)
	return running.data, running.err
}

// keptIndex is the body of the last 200 answer of an index URL with the validators of that answer.
type keptIndex struct {
	etag, modified string
	body           []byte
}

// indexFlight is a running read of an index URL: the reads that start while it runs wait for done and take its result.
// It is written here because golang.org/x/sync/singleflight does not report the reads that wait, which the check of
// sharing needs to start a read while another runs.
type indexFlight struct {
	done    chan struct{}
	waiters int
	data    []byte
	err     error
}

// fetching is the state that the fetchers of the process share: one client for each trust configuration, the kept index
// bodies and the running index reads, each by URL.
var fetching = struct {
	mu      sync.Mutex
	clients map[*tls.Config]*http.Client
	kept    map[string]keptIndex
	flights map[string]*indexFlight
}{clients: map[*tls.Config]*http.Client{}, kept: map[string]keptIndex{}, flights: map[string]*indexFlight{}}

// IndexReadWaiters reports how many reads of the index at location wait for the running read of that location. A check
// uses it to start a read while another one runs.
func IndexReadWaiters(location string) int {
	fetching.mu.Lock()
	defer fetching.mu.Unlock()
	if running := fetching.flights[location]; running != nil {
		return running.waiters
	}
	return 0
}

// client returns the client of the process for the trust configuration of f. Its transport keeps the connections open
// between requests.
func (f Fetcher) client() *http.Client {
	fetching.mu.Lock()
	defer fetching.mu.Unlock()
	if client := fetching.clients[f.TLS]; client != nil {
		return client
	}
	client := &http.Client{
		Transport: &http.Transport{TLSClientConfig: f.TLS, Proxy: http.ProxyFromEnvironment, ForceAttemptHTTP2: true},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			location := via[0].URL.String()
			if req.URL.Scheme != "https" {
				return errRedirect{fmt.Sprintf("%s: redirect to %s is not https", location, req.URL)}
			}
			if len(via) > maxRedirects {
				return errRedirect{fmt.Sprintf("%s: more than %d redirects", location, maxRedirects)}
			}
			return nil
		},
	}
	fetching.clients[f.TLS] = client
	return client
}

// get reads the https: location within limit. With validators it sends them and takes their body for the answer 304. An
// index read keeps the body and the validators of a 200 answer, and a 200 answer without validators removes the kept body.
func (f Fetcher) get(location string, limit Limit, index bool, validators *keptIndex) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), limit.Timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, fmt.Errorf("%s: the URL must be https: or an absolute file: URL", location)
	}
	if validators != nil {
		if validators.etag != "" {
			request.Header.Set("If-None-Match", validators.etag)
		}
		if validators.modified != "" {
			request.Header.Set("If-Modified-Since", validators.modified)
		}
	}
	response, err := f.client().Do(request)
	if err != nil {
		return nil, f.failure(location, limit, ctx, err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified && validators != nil {
		return validators.body, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", location, response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit.Bytes+1))
	if err != nil {
		return nil, f.failure(location, limit, ctx, err)
	}
	if int64(len(data)) > limit.Bytes {
		return nil, fmt.Errorf("%s: larger than %d bytes", location, limit.Bytes)
	}
	if index {
		etag, modified := response.Header.Get("ETag"), response.Header.Get("Last-Modified")
		fetching.mu.Lock()
		if etag != "" || modified != "" {
			fetching.kept[location] = keptIndex{etag: etag, modified: modified, body: data}
		} else {
			delete(fetching.kept, location)
		}
		fetching.mu.Unlock()
	}
	return data, nil
}

// failure turns a request error into the sentence of the specification.
func (f Fetcher) failure(location string, limit Limit, ctx context.Context, err error) error {
	var redirect errRedirect
	if errors.As(err, &redirect) {
		return redirect
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("%s: timed out after %d s", location, int(limit.Timeout/time.Second))
	}
	var urlError *url.Error
	if errors.As(err, &urlError) {
		err = urlError.Err
	}
	return fmt.Errorf("%s: cannot connect: %v", location, err)
}
