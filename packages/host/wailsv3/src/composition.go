package host

// 표면 하나의 모든 네이티브 영역과 선언된 DOM 오버레이를 완전한 스냅샷으로 배치한다.

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
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

type CompositionDeclareRequest struct {
	Surface string `json:"surface"`
	// Plugin is the id of the plugin whose page the surface shows; its document regions serve that plugin's package.
	Plugin      string             `json:"plugin"`
	Composition SurfaceComposition `json:"composition"`
}

type pendingConfigure struct {
	key           ImageKey
	configuration *ImageConfigure
}

func (s *Surfaces) releaseImageConfigurations(configurations []pendingConfigure) {
	for _, pending := range configurations {
		s.images.RetryConfigure(pending.key, pending.configuration.Generation, pending.configuration.Raster)
	}
}

func (s *Surfaces) sendImageConfigurations(configurations []pendingConfigure) error {
	for index, pending := range configurations {
		configuration := pending.configuration
		body, err := json.Marshal(map[string]any{"image": map[string]any{"configure": configuration}})
		if err != nil {
			s.releaseImageConfigurations(configurations[index:])
			return err
		}
		if err := s.sidecars.Send(configuration.Owner, configuration.Sidecar, pending.key.Surface, body); err != nil {
			s.releaseImageConfigurations(configurations[index:])
			return err
		}
		s.observeRaster(pending.key, "sent", "sidecar", configuration.Width, configuration.Height, configuration.Scale)
	}
	return nil
}

// rasterFacts 는 래스터 크기를 정하지 못한 영역의 측정 상태(배치, 크기, 표면 배율)를 오류에 싣는다.
func rasterFacts(handle unsafe.Pointer) string {
	facts, err := system.FactsImage(handle)
	if err != nil {
		return err.Error()
	}
	return facts
}

// observeRaster 는 그림 영역의 래스터 결정을 성능 트레이스에 남긴다. configured 는 사이드카에 보낼 크기를 정한 것이고,
// deferred 는 표면이 아직 배치되지 않아 크기를 정하지 못하고 미룬 것이다(docs/spec/performance-trace.md).
func (s *Surfaces) observeRaster(key ImageKey, phase, from string, width, height int, scale float64) {
	PerformanceObserve(s.host.configDir, "host", func() map[string]any {
		return map[string]any{"event": "image.raster", "surface": key.Surface, "name": key.Name, "phase": phase,
			"from": from, "width": width, "height": height, "scale": scale}
	})
}

// 표면 복귀나 바깥 크기 변경은 DOM 여백이 같아도 실제 네이티브 래스터를 갱신해야 한다.
func (s *Surfaces) refreshImageRasters() error {
	return s.refreshRastersWhere("refresh", func() map[ImageKey]unsafe.Pointer { return s.images.Visible() })
}

// RefreshSidecarRasters 는 영속 사이드카의 연결이 다시 맺히면 그 사이드카의 그림
// configure 를 다시 보낸다(V5-106). 새 연결의 서비스는 그림 상태가 없고, 크기가 같아도
// configure 상태는 연결과 함께 죽었으므로(InvalidateSidecar) 같은 크기의 재전송이 일어난다.
func (s *Surfaces) RefreshSidecarRasters(sidecar string) error {
	s.images.InvalidateSidecar(sidecar)
	return s.refreshRastersWhere("reconnect", func() map[ImageKey]unsafe.Pointer {
		return s.images.VisibleForSidecar(sidecar)
	})
}

func (s *Surfaces) refreshRastersWhere(from string, visible func() map[ImageKey]unsafe.Pointer) error {
	var configurations []pendingConfigure
	var failure error
	application.InvokeSync(func() {
		for key, handle := range visible() {
			// 아직 배치되지 않은 표면의 영역은 래스터 크기가 없다. 표면을 배치하는 다음 준비에서 갱신한다.
			if !system.SurfacePlacedImage(handle) {
				s.observeRaster(key, "deferred", from, 0, 0, 0)
				continue
			}
			width, height, scale, ok := system.RasterImage(handle)
			if !ok {
				failure = fmt.Errorf("image %q has no raster geometry: %s", key.Name, rasterFacts(handle))
				return
			}
			configuration, err := s.images.ConfigureRaster(key, width, height, scale, true)
			if err != nil {
				failure = err
				return
			}
			if configuration != nil {
				s.observeRaster(key, "configured", from, width, height, scale)
				configurations = append(configurations, pendingConfigure{key, configuration})
			}
		}
	})
	if failure != nil {
		s.releaseImageConfigurations(configurations)
		return failure
	}
	return s.sendImageConfigurations(configurations)
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

// declareComposition 은 surface 가 첫 frame 을 배치하기 전에 변경할 수 없는
// composition contract 를 등록한다.
func (s *Surfaces) declareComposition(viewID uint64, request CompositionDeclareRequest) error {
	if request.Surface == "" {
		return fmt.Errorf("composition declaration requires a surface")
	}
	if request.Plugin == "" {
		return fmt.Errorf("composition declaration of surface %q requires its plugin", request.Surface)
	}
	if err := s.authorizeSurface(viewID, request.Surface); err != nil {
		return err
	}
	if err := validateComposition(request.Composition); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if previous, exists := s.compositions[request.Surface]; exists {
		if !reflect.DeepEqual(previous, request.Composition) || s.surfacePlugins[request.Surface] != request.Plugin {
			return fmt.Errorf("surface %q changed its composition declaration", request.Surface)
		}
		return nil
	}
	s.compositions[request.Surface] = request.Composition
	s.surfacePlugins[request.Surface] = request.Plugin
	return nil
}

func (s *Surfaces) placeComposition(viewID uint64, request CompositionPlaceRequest) error {
	if err := s.authorizeSurface(viewID, request.Surface); err != nil {
		return err
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
					if system.SurfacePlacedImage(region.handle) {
						err = fmt.Errorf("image %q has no raster geometry: %s", region.declaration.Name, rasterFacts(region.handle))
						return
					}
					s.observeRaster(key, "deferred", "composition", 0, 0, 0)
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
						s.observeRaster(key, "configured", "composition", width, height, scale)
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
		s.releaseImageConfigurations(configurations)
		return err
	}
	if err := s.sendImageConfigurations(configurations); err != nil {
		return err
	}
	s.windowChanged()
	return nil
}
