package host

import (
	stdbytes "bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
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

// ValidateClipboardRead 는 명시적 사용자 붙여넣기에서 지원하는 형식을 읽는 요청만 허용한다.
func ValidateClipboardRead(kind string, userInitiated bool) error {
	if !userInitiated {
		return fmt.Errorf("clipboard read requires an explicit user paste")
	}
	if kind != "text" && kind != "png" && kind != "fileURLs" {
		return fmt.Errorf("unsupported clipboard type %q", kind)
	}
	return nil
}

func (h *Host) ClipboardRead(ctx context.Context, requestJSON json.RawMessage) (ClipboardReadResponse, error) {
	request, err := argument[ClipboardReadRequest]("request", requestJSON)
	if err != nil {
		return ClipboardReadResponse{}, err
	}
	if _, err := h.surface(ctx); err != nil {
		return ClipboardReadResponse{}, err
	}
	if err := ValidateClipboardRead(request.Type, request.UserInitiated); err != nil {
		return ClipboardReadResponse{}, err
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
		return ClipboardReadResponse{Present: false, Type: request.Type}, nil
	}
	response := ClipboardReadResponse{Present: true, Type: value.Type, Text: value.Text, URLs: value.URLs}
	if len(value.PNG) > clipboardMaxBytes {
		return ClipboardReadResponse{}, fmt.Errorf("clipboard PNG exceeds 16 MiB")
	}
	if len(value.PNG) > 0 {
		response.Data = base64.StdEncoding.EncodeToString(value.PNG)
	}
	return response, nil
}

func (h *Host) ClipboardWriteText(ctx context.Context, textJSON json.RawMessage) error {
	text, err := argument[string]("text", textJSON)
	if err != nil {
		return err
	}
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

func (h *Host) ClipboardPersistPNG(ctx context.Context, requestJSON json.RawMessage) (map[string]string, error) {
	request, err := argument[ClipboardPersistRequest]("request", requestJSON)
	if err != nil {
		return nil, err
	}
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

var pngSignature = []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}

// PersistClipboardPNG 는 소유한 PNG 를 주어진 config 디렉터리 아래에 기록한다.
func PersistClipboardPNG(root string, bytes []byte) (string, error) {
	if len(bytes) == 0 || len(bytes) > clipboardMaxBytes {
		return "", fmt.Errorf("clipboard PNG size is invalid")
	}
	if !stdbytes.HasPrefix(bytes, pngSignature) {
		return "", fmt.Errorf("clipboard PNG signature is missing")
	}
	if err := validatePNGHeader(bytes); err != nil {
		return "", fmt.Errorf("clipboard PNG header is invalid: %w", err)
	}
	system, err := platform.Current()
	if err != nil {
		return "", err
	}
	directory := filepath.Join(root, "clipboard")
	if err := system.CreatePrivateDirectories(directory); err != nil {
		return "", err
	}
	for i := 0; i < 16; i++ {
		stamp := time.Now().UnixNano()
		serial := atomic.AddUint64(&clipboardSerial, 1)
		path := filepath.Join(directory, fmt.Sprintf("pasted-image-%x-%x.png", stamp, serial))
		file, err := system.CreatePrivateFile(path)
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

// validatePNGHeader 는 서명 뒤의 첫 청크가 13바이트 IHDR 인지 검사한다(PNG 명세 11.2.2).
func validatePNGHeader(bytes []byte) error {
	if len(bytes) < 33 {
		return errors.New("the IHDR chunk is truncated")
	}
	chunk := bytes[8:33]
	if binary.BigEndian.Uint32(chunk[0:4]) != 13 || string(chunk[4:8]) != "IHDR" {
		return errors.New("the first chunk is not a 13-byte IHDR")
	}
	if crc32.ChecksumIEEE(chunk[4:21]) != binary.BigEndian.Uint32(chunk[21:25]) {
		return errors.New("the IHDR CRC does not match")
	}
	if binary.BigEndian.Uint32(chunk[8:12]) == 0 || binary.BigEndian.Uint32(chunk[12:16]) == 0 {
		return errors.New("the width or height is zero")
	}
	allowed := map[byte][]byte{0: {1, 2, 4, 8, 16}, 3: {1, 2, 4, 8}, 2: {8, 16}, 4: {8, 16}, 6: {8, 16}}
	depths, ok := allowed[chunk[17]]
	if !ok {
		return errors.New("the color type is not a PNG color type")
	}
	if !stdbytes.Contains(depths, chunk[16:17]) {
		return errors.New("the bit depth is not allowed for the color type")
	}
	if chunk[18] != 0 || chunk[19] != 0 || chunk[20] > 1 {
		return errors.New("the compression, filter, or interlace method is not a PNG method")
	}
	return nil
}
