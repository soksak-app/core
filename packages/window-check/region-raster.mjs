// The presented raster of a native image region has the size of its frame once the region shows the screen of its frame size. The raster
// size is in device pixels and the frame is in points, so the raster matches the frame multiplied by the scale that the host reports for
// the window, within one device pixel, and the raster has that scale.
export function presentsFrame(region, scale) {
  return Boolean(region?.visible && region.presented && region.presented.scale === scale
    && Math.abs(region.presented.width - region.frame.width * scale) <= 1
    && Math.abs(region.presented.height - region.frame.height * scale) <= 1);
}
