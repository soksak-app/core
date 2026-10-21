//! Places all native regions and the declared DOM overlays of one surface as one complete snapshot.

use std::sync::PoisonError;

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use tauri::{Manager, Webview, Window};

use crate::exposure;
use crate::images::{Configure, Images, Key};
use crate::platform::{self, DOMOverlay, Insets};
use crate::sidecars::WindowSidecars;
use crate::windows::window_data;

fn release_image_configurations(images: &Images, configurations: &[(Key, Configure)]) {
    for (key, configuration) in configurations {
        images.retry_configure(key, configuration.generation, configuration.raster);
    }
}

fn send_image_configurations(
    window: &Window,
    configurations: Vec<(Key, Configure)>,
) -> Result<(), String> {
    let data = window_data(window)?;
    for (index, (key, configuration)) in configurations.iter().enumerate() {
        let sent = serde_json::value::to_raw_value(&serde_json::json!({
            "image": { "configure": configuration }
        }))
        .map_err(|e| e.to_string())
        .and_then(|body| {
            window
                .state::<WindowSidecars>()
                .send(window, &configuration.sidecar, &key.0, &body)
        });
        if let Err(error) = sent {
            release_image_configurations(&data.images, &configurations[index..]);
            return Err(error);
        }
        observe_raster(
            key,
            "sent",
            "sidecar",
            Some(&platform::Raster {
                width: configuration.width,
                height: configuration.height,
                scale: configuration.scale,
            }),
        );
    }
    Ok(())
}

/// Puts the measured state (placement, size, surface scale) of a region whose raster size could not be determined into
/// the error.
fn raster_facts(platform: &dyn platform::Platform, handle: platform::Handle) -> String {
    // default: when the measured state cannot be read, the text of that error is put in its place. Either way it enters
    // the error report.
    platform.image_facts(handle).unwrap_or_else(|error| error)
}

/// Records the raster decision of an image region in the performance trace. configured means that the size to send to
/// the sidecar was determined, and deferred means that the surface is not placed yet, so the size could not be
/// determined and was postponed (docs/spec/performance-trace.md).
fn observe_raster(key: &Key, phase: &str, from: &str, raster: Option<&platform::Raster>) {
    crate::performance::observe("host", || {
        serde_json::json!({
            "event": "image.raster", "surface": key.0, "name": key.1, "phase": phase, "from": from,
            // default: a postponed decision has no size, so 0 is written.
            "width": raster.map_or(0, |raster| raster.width),
            "height": raster.map_or(0, |raster| raster.height),
            "scale": raster.map_or(0.0, |raster| raster.scale),
        })
    });
}

/// Measures the raster of the visible regions and collects the configure messages to send again. selection chooses the
/// targets.
fn collect_raster_configurations(
    window: &Window,
    from: &'static str,
    selection: impl Fn(&crate::images::Images) -> Vec<(crate::images::Key, platform::Handle)>
    + Send
    + 'static,
) -> Result<Vec<(crate::images::Key, crate::images::Configure)>, String> {
    let data = window_data(window)?;
    exposure::on_main(window, move || {
        let platform = platform::current()?;
        let mut configurations = Vec::new();
        let result = (|| -> Result<(), String> {
            for (key, handle) in selection(&data.images) {
                // A region of a surface that is not placed yet has no raster size. The next preparation that places the
                // surface updates it.
                if !platform.image_surface_placed(handle)? {
                    observe_raster(&key, "deferred", from, None);
                    continue;
                }
                let raster = platform.image_raster(handle)?.ok_or_else(|| {
                    format!(
                        "image {:?} has no raster geometry: {}",
                        key.1,
                        raster_facts(platform, handle)
                    )
                })?;
                if let Some(configuration) = data.images.configure_raster(
                    &key,
                    raster.width,
                    raster.height,
                    raster.scale,
                    true,
                )? {
                    observe_raster(&key, "configured", from, Some(&raster));
                    configurations.push((key, configuration));
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            release_image_configurations(&data.images, &configurations);
            return Err(error);
        }
        Ok(configurations)
    })
}

/// A surface restore or an outer size change must update the actual native raster even when the DOM insets are the
/// same.
pub(crate) fn refresh_image_rasters(window: &Window) -> Result<(), String> {
    let configurations =
        collect_raster_configurations(window, "refresh", |images| images.visible())?;
    send_image_configurations(window, configurations)
}

/// When the connection of a persistent sidecar is established again, sends the image configure messages of that sidecar
/// again (V5-106). The service of the new connection has no image state, and the configure state died together with the
/// connection even if the size is the same ([Images::invalidate_sidecar]), so the same size is sent again.
pub(crate) fn refresh_sidecar_rasters(window: &Window, sidecar: &str) -> Result<(), String> {
    window_data(window)?.images.invalidate_sidecar(sidecar);
    let sidecar = sidecar.to_string();
    let configurations = collect_raster_configurations(window, "reconnect", move |images| {
        images.visible_for_sidecar(&sidecar)
    })?;
    send_image_configurations(window, configurations)
}

/// The placement of one region or cover. The insets are in the object of the same name.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct CompositionPlacement {
    name: String,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    visible: bool,
}

impl CompositionPlacement {
    fn insets(&self) -> Insets {
        Insets {
            left: self.left,
            top: self.top,
            right: self.right,
            bottom: self.bottom,
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct CompositionPlaceRequest {
    surface: String,
    revision: u64,
    regions: Vec<CompositionPlacement>,
    overlays: Vec<CompositionPlacement>,
}

/// The DOM overlays of a surface in the order of its declaration. Each keeps the insets and the visibility of its placement.
fn dom_overlays(
    names: &[String],
    overlays: &HashMap<String, CompositionPlacement>,
) -> Vec<DOMOverlay> {
    names
        .iter()
        .map(|name| {
            let placement = overlays.get(name).expect("validated above");
            DOMOverlay {
                insets: placement.insets(),
                visible: placement.visible,
            }
        })
        .collect()
}

fn exact_placements(
    values: Vec<CompositionPlacement>,
    names: &[String],
    what: &str,
) -> Result<HashMap<String, CompositionPlacement>, String> {
    if values.len() != names.len() {
        return Err(format!(
            "composition {what} must exactly match its declaration"
        ));
    }
    let wanted: HashSet<_> = names.iter().cloned().collect();
    let mut got = HashMap::new();
    for value in values {
        let finite = [value.left, value.top, value.right, value.bottom]
            .iter()
            .all(|number| number.is_finite());
        let name = value.name.clone();
        if !wanted.contains(&name) || got.contains_key(&name) || !finite {
            return Err(format!("invalid or duplicate composition {what} {name:?}"));
        }
        got.insert(name, value);
    }
    Ok(got)
}

/// Places all native regions and DOM overlays of the calling surface as one complete revision.
pub(crate) fn place(webview: &Webview, request: CompositionPlaceRequest) -> Result<(), String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(
        webview.label(),
        window.label(),
        "composition operations",
    )?;
    if request.surface.is_empty() {
        return Err(format!(
            "this composition is not surface {:?}",
            request.surface
        ));
    }
    if request.revision == 0 {
        return Err("composition revision must be positive".into());
    }
    let data = window_data(&window)?;
    let declaration = data
        .compositions
        .lock()
        // default: a lock that a panicking thread poisoned still holds the composition declarations, which are only
        // read; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(&request.surface)
        .cloned()
        .ok_or_else(|| {
            format!(
                "surface {:?} has no composition declaration",
                request.surface
            )
        })?;
    let region_names: Vec<_> = declaration
        .regions
        .iter()
        .map(|region| region.name.clone())
        .collect();
    // default: a surface that declared no overlays has no overlay.
    let overlay_names = declaration.overlays.clone().unwrap_or_default();
    let regions = exact_placements(request.regions, &region_names, "regions")?;
    let overlays = exact_placements(request.overlays, &overlay_names, "overlays")?;
    let platform = platform::current()?;
    let surface_handle = data
        .surface_hosts
        .lock()
        // default: a lock that a panicking thread poisoned still holds the surface registrations, which are only read;
        // the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(&request.surface)
        .copied()
        .ok_or_else(|| format!("surface {:?} is not attached", request.surface))?;
    let surface = request.surface;
    let revision = request.revision;
    let host = window.clone();
    let applied_data = data.clone();
    let configurations = exposure::on_main(&window, move || {
        let mut revisions = applied_data
            .composition_revisions
            .lock()
            // default: a lock that a panicking thread poisoned still holds the composition revisions, which the
            // placement amends; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        // default: the last revision of a surface that has not received a placement is 0.
        if revision <= revisions.get(&surface).copied().unwrap_or_default() {
            return Err(format!("stale composition revision {revision}"));
        }
        let mut resolved = Vec::with_capacity(declaration.regions.len());
        for region in &declaration.regions {
            let key = (surface.clone(), region.name.clone());
            let handle = if region.kind == "document" {
                applied_data.documents.get(&key)?
            } else {
                applied_data.images.get(&key)?
            };
            resolved.push((region.clone(), handle));
        }
        let mut configurations = Vec::new();
        let result = (|| -> Result<(), String> {
            for (region, handle) in resolved {
                let placement = regions.get(&region.name).expect("validated above");
                if region.kind == "document" {
                    platform.place_document(handle, placement.insets(), placement.visible)?;
                } else {
                    platform.place_image(handle, placement.insets(), placement.visible)?;
                    let key = (surface.clone(), region.name.clone());
                    applied_data.images.set_visible(&key, placement.visible)?;
                    match platform.image_raster(handle)? {
                        Some(raster) => {
                            if let Some(configuration) = applied_data.images.configure_raster(
                                &key,
                                raster.width,
                                raster.height,
                                raster.scale,
                                placement.visible,
                            )? {
                                observe_raster(&key, "configured", "composition", Some(&raster));
                                configurations.push((key, configuration));
                            }
                        }
                        None if placement.visible && platform.image_surface_placed(handle)? => {
                            return Err(format!(
                                "image {:?} has no raster geometry: {}",
                                region.name,
                                raster_facts(platform, handle)
                            ));
                        }
                        None if placement.visible => {
                            observe_raster(&key, "deferred", "composition", None);
                        }
                        None => {}
                    }
                }
            }
            let native_overlays = dom_overlays(&overlay_names, &overlays);
            platform.set_surface_overlays(surface_handle, &native_overlays)?;
            revisions.insert(surface, revision);
            Ok(())
        })();
        if let Err(error) = result {
            release_image_configurations(&applied_data.images, &configurations);
            return Err(error);
        }
        exposure::window_changed(&host);
        Ok(configurations)
    })?;
    send_image_configurations(&window, configurations)
}

#[cfg(test)]
#[path = "composition_overlay_test.rs"]
mod overlay_test;
