package main

import "context"

func (h *Host) WindowControls(ctx context.Context) (Rect, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return Rect{}, err
	}
	return s.WindowControls()
}

func (h *Host) OverlayShow(ctx context.Context, req OverlayRequest) (Rect, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return Rect{}, err
	}
	return s.OverlayShow(req)
}

func (h *Host) SetShape(ctx context.Context, req ShapeRequest) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.SetShape(req)
}

func (h *Host) ClearShape(ctx context.Context, id string) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.ClearShape(id)
}

func (h *Host) OverlayPlace(ctx context.Context, req PlaceRequest) (Rect, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return Rect{}, err
	}
	return s.OverlayPlace(req)
}

func (h *Host) OverlayHide(ctx context.Context, id string) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.OverlayHide(id)
}

func (h *Host) Report(ctx context.Context, line string) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.Report(line)
}

func (h *Host) SetTheme(ctx context.Context, theme Theme) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return s.SetTheme(theme)
}

func (h *Host) SyncSurfaces(ctx context.Context, req SyncRequest) (PreparedSurfaces, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return PreparedSurfaces{}, err
	}
	return s.SyncSurfaces(req)
}

func (h *Host) PresentSurfaces(ctx context.Context, req PresentRequest) ([]Placement, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return nil, err
	}
	return s.PresentSurfaces(req)
}

func (h *Host) OverlayUpdate(ctx context.Context, req UpdateRequest) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	s.OverlayUpdate(req)
	return nil
}
