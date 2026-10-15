package tests

// Checks the release recipe of an application (docs/spec/installation.md#applications): the installer downloads the
// release of the application's own repository through a TLS server that the check owns, compares its SHA-256, unpacks it
// into the folder of the application, and leaves no folder when a step fails.

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

// releaseServer serves the bytes at every path and returns a fetcher that trusts the server, with a release limit that
// holds them.
func releaseServer(t *testing.T, body []byte) (*httptest.Server, sok.Fetcher) {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
	t.Cleanup(server.Close)
	fetcher := tlsFetcher(server)
	fetcher.Release = sok.Limit{Bytes: 1 << 20, Timeout: 10 * time.Second}
	return server, fetcher
}

func sum(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

// gzipTar holds an executable, a folder and a symbolic link inside the folder, as the release of a bundle does.
func gzipTar(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	zipped := gzip.NewWriter(&buffer)
	builder := tar.NewWriter(zipped)
	entries := []tar.Header{
		{Name: "sketcher/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: "sketcher/bin/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: "sketcher/bin/sketcher", Typeflag: tar.TypeReg, Mode: 0o755, Size: 10},
		{Name: "sketcher/current", Typeflag: tar.TypeSymlink, Linkname: "bin", Mode: 0o777},
	}
	for _, header := range entries {
		header := header
		if err := builder.WriteHeader(&header); err != nil {
			t.Fatal(err)
		}
		if header.Typeflag == tar.TypeReg {
			_, _ = builder.Write([]byte("#!/bin/sh\n"))
		}
	}
	if err := builder.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// contract: application.release.downloads-compares-unpacks
func TestAReleaseIsDownloadedComparedAndUnpackedIntoTheFolderOfTheApplication(t *testing.T) {
	data := gzipTar(t)
	server, fetcher := releaseServer(t, data)
	target := filepath.Join(t.TempDir(), "applications", "sketcher", "1.0.0")
	recipe := map[string]string{"kind": "release", "url": server.URL + "/sketcher.tar.gz", "sha256": sum(data), "unpack": "tar.gz"}
	if err := sok.InstallApplicationRelease(fetcher, recipe, target); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(target, "sketcher", "bin", "sketcher"))
	if err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("the executable of the release: %v %v", info, err)
	}
	if link, err := os.Readlink(filepath.Join(target, "sketcher", "current")); err != nil || link != "bin" {
		t.Fatalf("the symbolic link of the release: %q %v", link, err)
	}
}

// contract: application.release.refuses-other-hash
func TestAReleaseOfAnotherHashIsRefusedAndLeavesNoFolder(t *testing.T) {
	data := gzipTar(t)
	server, fetcher := releaseServer(t, data)
	target := filepath.Join(t.TempDir(), "sketcher")
	recipe := map[string]string{"kind": "release", "url": server.URL + "/sketcher.tar.gz", "sha256": strings.Repeat("0", 64), "unpack": "tar.gz"}
	err := sok.InstallApplicationRelease(fetcher, recipe, target)
	if err == nil || !strings.Contains(err.Error(), "sha256 "+sum(data)+" is not "+strings.Repeat("0", 64)) {
		t.Fatalf("err %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(target)); len(entries) != 0 {
		t.Fatalf("the failed installation left %v", entries)
	}
}

// contract: application.release.refuses-escaping-link
func TestALinkThatLeavesTheFolderIsRefused(t *testing.T) {
	var buffer bytes.Buffer
	zipped := gzip.NewWriter(&buffer)
	builder := tar.NewWriter(zipped)
	_ = builder.WriteHeader(&tar.Header{Name: "escape", Typeflag: tar.TypeSymlink, Linkname: "../../outside", Mode: 0o777})
	_ = builder.Close()
	_ = zipped.Close()
	data := buffer.Bytes()
	server, fetcher := releaseServer(t, data)
	target := filepath.Join(t.TempDir(), "sketcher")
	recipe := map[string]string{"kind": "release", "url": server.URL + "/sketcher.tar.gz", "sha256": sum(data), "unpack": "tar.gz"}
	err := sok.InstallApplicationRelease(fetcher, recipe, target)
	if err == nil || !strings.Contains(err.Error(), "release entry escape links outside the folder") {
		t.Fatalf("err %v", err)
	}
}

// contract: application.release.one-executable
func TestAReleaseWithoutUnpackIsOneExecutable(t *testing.T) {
	data := []byte("#!/bin/sh\necho sketcher\n")
	server, fetcher := releaseServer(t, data)
	target := filepath.Join(t.TempDir(), "sketcher")
	recipe := map[string]string{"kind": "release", "url": server.URL + "/download/sketcher", "sha256": sum(data), "unpack": "none"}
	if err := sok.InstallApplicationRelease(fetcher, recipe, target); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(target, "sketcher"))
	if err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("the executable: %v %v", info, err)
	}
}

// A zip is extracted by the bundle extraction of the platform, which darwin implements; another platform refuses it.
// contract: application.release.zip-by-platform
func TestAZipReleaseIsExtractedByThePlatform(t *testing.T) {
	var buffer bytes.Buffer
	builder := zip.NewWriter(&buffer)
	header := &zip.FileHeader{Name: "sketcher/sketcher", Method: zip.Deflate}
	header.SetMode(0o755)
	writer, err := builder.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = writer.Write([]byte("#!/bin/sh\n"))
	if err := builder.Close(); err != nil {
		t.Fatal(err)
	}
	data := buffer.Bytes()
	server, fetcher := releaseServer(t, data)
	target := filepath.Join(t.TempDir(), "sketcher")
	recipe := map[string]string{"kind": "release", "url": server.URL + "/sketcher.zip", "sha256": sum(data), "unpack": "zip"}
	err = sok.InstallApplicationRelease(fetcher, recipe, target)
	current, platformErr := platform.Current()
	if platformErr != nil {
		t.Fatal(platformErr)
	}
	key, keyErr := current.Key()
	if keyErr != nil {
		t.Fatal(keyErr)
	}
	if !strings.HasPrefix(key, "darwin-") {
		if err == nil || !strings.Contains(err.Error(), "not implemented on") {
			t.Fatalf("%s: err %v", key, err)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(target, "sketcher", "sketcher"))
	if err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("the executable of the zip: %v %v", info, err)
	}
}
