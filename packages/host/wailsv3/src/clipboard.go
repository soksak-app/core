package host

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
	"github.com/wailsapp/wails/v3/pkg/application"
)

const clipboardMaxBytes = 16 * 1024 * 1024

var clipboardSerial uint64

type ClipboardReadRequest struct {
	Type          string `json:"type"`
	UserInitiated bool   `json:"userInitiated"`
}

type ClipboardReadResponse struct {
	Present bool     `json:"present"`
	Type    string   `json:"type,omitempty"`
	Text    string   `json:"text,omitempty"`
	Data    string   `json:"data,omitempty"`
	URLs    []string `json:"urls,omitempty"`
}

type ClipboardPersistRequest struct {
	Data string `json:"data"`
}

func (h *Host) ClipboardRead(ctx context.Context, request ClipboardReadRequest) (ClipboardReadResponse, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return ClipboardReadResponse{}, err
	}
	if !request.UserInitiated {
		return ClipboardReadResponse{}, fmt.Errorf("clipboard read requires an explicit user paste")
	}
	if request.Type != "text" && request.Type != "png" && request.Type != "fileURLs" {
		return ClipboardReadResponse{}, fmt.Errorf("unsupported clipboard type")
	}
	var value platform.ClipboardValue
	var callErr error
	application.InvokeSync(func() {
		current, err := platform.Current()
		if err != nil {
			callErr = err
			return
		}
		value, callErr = current.ClipboardRead(request.Type)
	})
	if callErr != nil {
		return ClipboardReadResponse{}, callErr
	}
	if !value.Present {
		return ClipboardReadResponse{Present: false}, nil
	}
	response := ClipboardReadResponse{Present: true, Type: value.Type, Text: value.Text, URLs: value.URLs}
	if len(value.PNG) > clipboardMaxBytes {
		return ClipboardReadResponse{}, fmt.Errorf("clipboard PNG exceeds 16 MiB")
	}
	if len(value.PNG) > 0 {
		response.Data = base64.StdEncoding.EncodeToString(value.PNG)
	}
	_ = s
	return response, nil
}

func (h *Host) ClipboardWriteText(ctx context.Context, text string) error {
	if len(text) > clipboardMaxBytes {
		return fmt.Errorf("clipboard text exceeds 16 MiB")
	}
	if _, err := h.surface(ctx); err != nil {
		return err
	}
	var callErr error
	application.InvokeSync(func() {
		current, err := platform.Current()
		if err != nil {
			callErr = err
			return
		}
		callErr = current.ClipboardWriteText(text)
	})
	return callErr
}

func (h *Host) ClipboardPersistPNG(ctx context.Context, request ClipboardPersistRequest) (map[string]string, error) {
	if _, err := h.surface(ctx); err != nil {
		return nil, err
	}
	bytes, err := base64.StdEncoding.DecodeString(request.Data)
	if err != nil {
		return nil, err
	}
	path, err := PersistClipboardPNG(h.configDir, bytes)
	if err != nil {
		return nil, err
	}
	return map[string]string{"path": path}, nil
}

// PersistClipboardPNG writes an owned PNG below the supplied config directory.
func PersistClipboardPNG(root string, bytes []byte) (string, error) {
	if len(bytes) == 0 || len(bytes) > clipboardMaxBytes {
		return "", fmt.Errorf("clipboard PNG size is invalid")
	}
	directory := filepath.Join(root, "clipboard")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	for i := 0; i < 16; i++ {
		stamp := time.Now().UnixNano()
		serial := atomic.AddUint64(&clipboardSerial, 1)
		path := filepath.Join(directory, fmt.Sprintf("pasted-image-%x-%x.png", stamp, serial))
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		if _, err = file.Write(bytes); err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return "", err
		}
		return path, nil
	}
	return "", fmt.Errorf("cannot allocate a unique clipboard image path")
}
