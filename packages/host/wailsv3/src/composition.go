package host

// 표면 하나의 모든 네이티브 영역과 선언된 DOM 오버레이를 완전한 스냅샷으로 배치한다.

import (
	"encoding/json"
	"fmt"
	"math"
	"unsafe"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type CompositionPlacement struct {
	Name    string  `json:"name"`
	Left    float64 `json:"left"`
	Top     float64 `json:"top"`
	Right   float64 `json:"right"`
	Bottom  float64 `json:"bottom"`
	Visible bool    `json:"visible"`
}

type CompositionPlaceRequest struct {
	Surface  string                 `json:"surface"`
	Revision uint64                 `json:"revision"`
	Regions  []CompositionPlacement `json:"regions"`
	Overlays []CompositionPlacement `json:"overlays"`
}

func validPlacement(value CompositionPlacement) bool {
	for _, number := range []float64{value.Left, value.Top, value.Right, value.Bottom} {
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return false
		}
	}
	return true
}

func exactPlacements(values []CompositionPlacement, names []string, what string) (map[string]CompositionPlacement, error) {
	if len(values) != len(names) {
		return nil, fmt.Errorf("composition %s must exactly match its declaration", what)
	}
	wanted := make(map[string]bool, len(names))
	for _, name := range names {
		wanted[name] = true
	}
	got := make(map[string]CompositionPlacement, len(values))
	for _, value := range values {
		_, duplicate := got[value.Name]
		if !wanted[value.Name] || duplicate || !validPlacement(value) {
			return nil, fmt.Errorf("invalid or duplicate composition %s %q", what, value.Name)
		}
		got[value.Name] = value
	}
	return got, nil
}

func (s *Surfaces) placeComposition(viewID uint64, request CompositionPlaceRequest) error {
	caller := s.surfaceOf(viewID)
	if caller == "" || caller != request.Surface {
		return fmt.Errorf("this composition is not surface %q", request.Surface)
	}
	if request.Revision == 0 {
		return fmt.Errorf("composition revision must be positive")
	}

	s.mu.Lock()
	declaration, ok := s.compositions[request.Surface]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("surface %q has no composition declaration", request.Surface)
	}
	regionNames := make([]string, len(declaration.Regions))
	for index, region := range declaration.Regions {
		regionNames[index] = region.Name
	}
	regions, err := exactPlacements(request.Regions, regionNames, "regions")
	if err != nil {
		return err
	}
	type pendingConfigure struct {
		key           ImageKey
		configuration *ImageConfigure
	}
	var configurations []pendingConfigure
	overlays, err := exactPlacements(request.Overlays, declaration.Overlays, "overlays")
	if err != nil {
		return err
	}

	// 리비전 검사와 모든 네이티브 적용을 UI 스레드의 작업 하나로 실행한다. 호출 고루틴의
	// 도착 순서가 뒤집혀도 이전 리비전은 새 스냅샷 뒤에 적용되지 않는다.
	application.InvokeSync(func() {
		if request.Revision <= s.compositionRevisions[request.Surface] {
			err = fmt.Errorf("stale composition revision %d", request.Revision)
			return
		}
		view := s.views[request.Surface]
		if view == nil || view.handle == nil {
			err = fmt.Errorf("surface %q has no view", request.Surface)
			return
		}
		type nativeRegion struct {
			declaration SurfaceRegion
			handle      unsafe.Pointer
		}
		resolved := make([]nativeRegion, 0, len(declaration.Regions))
		for _, region := range declaration.Regions {
			var handle unsafe.Pointer
			if region.Kind == "document" {
				handle, err = s.documents.Get(DocumentKey{Surface: request.Surface, Name: region.Name})
			} else {
				handle, err = s.images.Get(ImageKey{Surface: request.Surface, Name: region.Name})
			}
			if err != nil {
				return
			}
			resolved = append(resolved, nativeRegion{declaration: region, handle: handle})
		}
		for _, region := range resolved {
			p := regions[region.declaration.Name]
			if region.declaration.Kind == "document" {
				system.PlaceDocument(region.handle, p.Left, p.Top, p.Right, p.Bottom, p.Visible)
			} else {
				system.PlaceImage(region.handle, p.Left, p.Top, p.Right, p.Bottom, p.Visible)
				key := ImageKey{Surface: request.Surface, Name: region.declaration.Name}
				if visibleErr := s.images.SetVisible(key, p.Visible); visibleErr != nil {
					err = visibleErr
					return
				}
				width, height, scale, ok := system.RasterImage(region.handle)
				if !ok && p.Visible {
					err = fmt.Errorf("image %q has no raster geometry", region.declaration.Name)
					return
				}
				if ok {
					configuration, configureErr := s.images.ConfigureRaster(
						key,
						width, height, scale, p.Visible)
					if configureErr != nil {
						err = configureErr
						return
					}
					if configuration != nil {
						configurations = append(configurations, pendingConfigure{
							key:           key,
							configuration: configuration,
						})
					}
				}
			}
		}
		nativeOverlays := make([]platform.DOMOverlay, 0, len(declaration.Overlays))
		for _, name := range declaration.Overlays {
			p := overlays[name]
			nativeOverlays = append(nativeOverlays, platform.DOMOverlay{
				Left: p.Left, Top: p.Top, Right: p.Right, Bottom: p.Bottom, Visible: p.Visible,
			})
		}
		system.SetSurfaceOverlays(view.handle, nativeOverlays)
		s.compositionRevisions[request.Surface] = request.Revision
	})
	if err != nil {
		return err
	}
	for _, pending := range configurations {
		body, marshalErr := json.Marshal(map[string]any{"image": map[string]any{"configure": pending.configuration}})
		if marshalErr != nil {
			return marshalErr
		}
		configuration := pending.configuration
		if sendErr := s.sidecars.Send(configuration.Owner, configuration.Sidecar, request.Surface, body); sendErr != nil {
			s.images.RetryConfigure(pending.key, configuration.Generation, configuration.Raster)
			return sendErr
		}
	}
	s.windowChanged()
	return nil
}
