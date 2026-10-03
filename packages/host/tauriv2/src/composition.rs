//! 표면 하나의 모든 네이티브 영역과 선언된 DOM 오버레이를 완전한 스냅샷으로 배치한다.

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
        if let Some(workspace) = window.try_state::<crate::workspace::Workspace>() {
            observe_raster(
                workspace.directory(),
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
    }
    Ok(())
}

/// 래스터 크기를 정하지 못한 영역의 측정 상태(배치, 크기, 표면 배율)를 오류에 싣는다.
fn raster_facts(platform: &dyn platform::Platform, handle: platform::Handle) -> String {
    // 기본값: 측정 상태를 읽지 못하면 그 오류 문장을 대신 싣는다. 어느 쪽이든 오류 보고에 들어간다.
    platform.image_facts(handle).unwrap_or_else(|error| error)
}

/// 그림 영역의 래스터 결정을 성능 트레이스에 남긴다. configured 는 사이드카에 보낼 크기를 정한 것이고, deferred 는
/// 표면이 아직 배치되지 않아 크기를 정하지 못하고 미룬 것이다(docs/spec/performance-trace.md).
fn observe_raster(
    directory: &std::path::Path,
    key: &Key,
    phase: &str,
    from: &str,
    raster: Option<&platform::Raster>,
) {
    crate::performance::observe(directory, "host", || {
        serde_json::json!({
            "event": "image.raster", "surface": key.0, "name": key.1, "phase": phase, "from": from,
            // 기본값: 미룬 결정에는 크기가 없으므로 0을 적는다.
            "width": raster.map_or(0, |raster| raster.width),
            "height": raster.map_or(0, |raster| raster.height),
            "scale": raster.map_or(0.0, |raster| raster.scale),
        })
    });
}

/// 보이는 영역의 래스터를 측정해 다시 보낼 configure 를 모은다. selection 이 대상을 고른다.
fn collect_raster_configurations(
    window: &Window,
    from: &'static str,
    selection: impl Fn(&crate::images::Images) -> Vec<(crate::images::Key, platform::Handle)>
        + Send
        + 'static,
) -> Result<Vec<(crate::images::Key, crate::images::Configure)>, String> {
    let data = window_data(window)?;
    let directory = window
        .state::<crate::workspace::Workspace>()
        .directory()
        .to_path_buf();
    exposure::on_main(window, move || {
        let platform = platform::current()?;
        let mut configurations = Vec::new();
        let result = (|| -> Result<(), String> {
            for (key, handle) in selection(&data.images) {
                // 아직 배치되지 않은 표면의 영역은 래스터 크기가 없다. 표면을 배치하는 다음 준비에서 갱신한다.
                if !platform.image_surface_placed(handle)? {
                    observe_raster(&directory, &key, "deferred", from, None);
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
                    observe_raster(&directory, &key, "configured", from, Some(&raster));
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

/// 표면 복귀나 바깥 크기 변경은 DOM 여백이 같아도 실제 네이티브 래스터를 갱신해야 한다.
pub(crate) fn refresh_image_rasters(window: &Window) -> Result<(), String> {
    let configurations =
        collect_raster_configurations(window, "refresh", |images| images.visible())?;
    send_image_configurations(window, configurations)
}

/// 영속 사이드카의 연결이 다시 맺히면 그 사이드카의 그림 configure 를 다시 보낸다(V5-106).
/// 새 연결의 서비스는 그림 상태가 없고, 크기가 같아도 configure 상태는 연결과 함께
/// 죽었으므로([Images::invalidate_sidecar]) 같은 크기의 재전송이 일어난다.
pub(crate) fn refresh_sidecar_rasters(window: &Window, sidecar: &str) -> Result<(), String> {
    window_data(window)?.images.invalidate_sidecar(sidecar);
    let sidecar = sidecar.to_string();
    let configurations = collect_raster_configurations(window, "reconnect", move |images| {
        images.visible_for_sidecar(&sidecar)
    })?;
    send_image_configurations(window, configurations)
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct CompositionPlacement {
    name: String,
    #[serde(flatten)]
    insets: Insets,
    visible: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CompositionPlaceRequest {
    surface: String,
    revision: u64,
    regions: Vec<CompositionPlacement>,
    overlays: Vec<CompositionPlacement>,
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
        let finite = [
            value.insets.left,
            value.insets.top,
            value.insets.right,
            value.insets.bottom,
        ]
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

/// 호출한 표면의 모든 네이티브 영역과 DOM 오버레이를 한 완전한 리비전으로 배치한다.
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
        .map_err(|e| e.to_string())?
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
    // 기본값: overlays 를 선언하지 않은 표면에는 오버레이가 없다.
    let overlay_names = declaration.overlays.clone().unwrap_or_default();
    let regions = exact_placements(request.regions, &region_names, "regions")?;
    let overlays = exact_placements(request.overlays, &overlay_names, "overlays")?;
    let platform = platform::current()?;
    let surface_handle = data
        .surface_hosts
        .lock()
        .map_err(|e| e.to_string())?
        .get(&request.surface)
        .copied()
        .ok_or_else(|| format!("surface {:?} is not attached", request.surface))?;
    let surface = request.surface;
    let revision = request.revision;
    let host = window.clone();
    let applied_data = data.clone();
    let directory = window
        .state::<crate::workspace::Workspace>()
        .directory()
        .to_path_buf();
    let configurations = exposure::on_main(&window, move || {
        let mut revisions = applied_data
            .composition_revisions
            .lock()
            .map_err(|e| e.to_string())?;
        // 기본값: 아직 배치를 받지 않은 표면의 마지막 판은 0 이다.
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
                    platform.place_document(handle, placement.insets, placement.visible)?;
                } else {
                    platform.place_image(handle, placement.insets, placement.visible)?;
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
                                observe_raster(
                                    &directory,
                                    &key,
                                    "configured",
                                    "composition",
                                    Some(&raster),
                                );
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
                            observe_raster(&directory, &key, "deferred", "composition", None);
                        }
                        None => {}
                    }
                }
            }
            let native_overlays: Vec<_> = overlay_names
                .iter()
                .map(|name| {
                    let placement = overlays.get(name).expect("validated above");
                    DOMOverlay {
                        insets: placement.insets,
                        visible: placement.visible,
                    }
                })
                .collect();
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
