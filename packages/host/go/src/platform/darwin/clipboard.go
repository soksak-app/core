//go:build darwin

package darwin

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

func clipboardJSON(value *byte) (map[string]any, error) {
	if value == nil {
		return nil, fmt.Errorf("clipboard native call returned null")
	}
	defer native.Free(unsafe.Pointer(value))
	var result map[string]any
	if err := json.Unmarshal([]byte(native.GoString(value)), &result); err != nil {
		return nil, fmt.Errorf("invalid clipboard response: %w", err)
	}
	return result, nil
}

func clipboardStatus(result map[string]any) error {
	if result["status"] == "error" {
		return fmt.Errorf("%v", result["error"])
	}
	if result["status"] != "ok" {
		return fmt.Errorf("clipboard operation was not accepted")
	}
	return nil
}

func (implementation) ClipboardRead(kind string) (platform.ClipboardValue, error) {
	board := native.MainSpClipboardOpen(nil)
	if board == nil {
		return platform.ClipboardValue{}, fmt.Errorf("cannot open system clipboard")
	}
	defer native.MainSpClipboardClose(board)
	var pointer *byte
	switch kind {
	case "text":
		pointer = native.MainSpClipboardReadText(board)
	case "png":
		pointer = native.MainSpClipboardReadPng(board)
	case "fileURLs":
		pointer = native.MainSpClipboardReadFileUrls(board)
	default:
		return platform.ClipboardValue{}, fmt.Errorf("unsupported clipboard type %s", kind)
	}
	result, err := clipboardJSON(pointer)
	if err != nil {
		return platform.ClipboardValue{}, err
	}
	// default: a status that is not a string becomes an empty string, and clipboardStatus below reports it as a not accepted error.
	status, _ := result["status"].(string)
	if status == "absent" {
		return platform.ClipboardValue{}, nil
	}
	if err := clipboardStatus(result); err != nil {
		return platform.ClipboardValue{}, err
	}
	value := platform.ClipboardValue{Present: true, Type: kind}
	switch kind {
	case "text":
		var ok bool
		value.Text, ok = result["text"].(string)
		if !ok {
			return platform.ClipboardValue{}, fmt.Errorf("clipboard text is invalid")
		}
	case "png":
		encoded, ok := result["base64"].(string)
		if !ok {
			return platform.ClipboardValue{}, fmt.Errorf("clipboard PNG is invalid")
		}
		value.PNG, err = base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(value.PNG) > 16*1024*1024 {
			return platform.ClipboardValue{}, fmt.Errorf("clipboard PNG is invalid or too large")
		}
	case "fileURLs":
		items, ok := result["urls"].([]any)
		if !ok {
			return platform.ClipboardValue{}, fmt.Errorf("clipboard file URLs are invalid")
		}
		for _, item := range items {
			url, ok := item.(string)
			if !ok {
				return platform.ClipboardValue{}, fmt.Errorf("clipboard file URL is invalid")
			}
			value.URLs = append(value.URLs, url)
		}
	}
	return value, nil
}

func (implementation) ClipboardWriteText(text string) error {
	board := native.MainSpClipboardOpen(nil)
	if board == nil {
		return fmt.Errorf("cannot open system clipboard")
	}
	defer native.MainSpClipboardClose(board)
	value := native.CString(text)
	defer native.Free(unsafe.Pointer(value))
	result, err := clipboardJSON(native.MainSpClipboardWriteText(board, value))
	if err != nil {
		return err
	}
	return clipboardStatus(result)
}
