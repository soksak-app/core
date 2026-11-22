//! The restart of the view of a tab (core.tab.reload, docs/spec/native-surfaces.md#view-surfaces).

use super::*;

/// Returns the record from which the view of surface is created again. A surface without a view record is refused with its id
/// (core.tab.reload).
pub(crate) fn reload_record(lifecycle: &ViewLifecycle, surface: &str) -> Result<ViewSpec, String> {
    lifecycle
        .spec(surface)
        .ok_or_else(|| format!("tab {surface}: no view to reload"))
}

/// Restarts the view of the tab surface: the lifecycle clears its restart failures and stop, the live view ends without a failure
/// (host.view.killed names the view-reloaded caller), and the view is created again from its record (core.tab.reload,
/// docs/spec/native-surfaces.md#view-surfaces).
pub fn reload_view(window: &Window, surface: &str) -> Result<(), String> {
    let data = window_data(window)?;
    let spec = reload_record(data.documents.lifecycle(), surface)?;
    let platform = platform::current()?;
    let owned_surface = surface.to_string();
    let for_main = window.clone();
    let owned_window = window.clone();
    on_main(window, move || {
        let surface = owned_surface.as_str();
        let key: Key = (owned_surface.clone(), VIEW_NAME.to_string());
        data.documents.lifecycle().reset(surface);
        if let Some(origin) = data.documents.views().current_origin(surface) {
            let document = data.documents.get(&key)?;
            data.documents
                .lifecycle()
                .record_end(surface, "view-reloaded");
            // The open calls are taken before the channel is removed, because the removal drops the channel of the view.
            let open_calls = data.documents.views().end_calls(surface);
            data.documents.views().forget_if_current(surface, &origin);
            if data
                .view_source_origins
                .end_view(surface, origin.generation)
                && let Err(error) = data.view_source_events.send(
                    "view-source-ended",
                    crate::source_origins::view_source_origin_event(
                        &spec.plugin,
                        Some(surface),
                        origin.generation,
                    ),
                )
            {
                log_error("view channel", error);
            }
            end_presentation_wait_for_generation(
                &for_main,
                surface,
                origin.generation,
                "view-reloaded",
            );
            data.documents.remove(&key)?;
            for (plugin, command) in &open_calls {
                record_view_call_peer_lost(plugin, command);
            }
            log_failure("view channel", platform.close_document(document));
            let (region_documents, region_images) =
                remove_view_regions(&data.documents, &data.streams, &data.images, surface);
            let regions_closed = !region_documents.is_empty() || !region_images.is_empty();
            for handle in region_documents {
                log_failure("view channel", platform.close_document(handle));
            }
            for handle in region_images {
                log_failure("view channel", platform.close_image(handle));
            }
            if regions_closed {
                exposure::window_changed(&for_main);
            }
        }
        sync_view(
            &owned_window,
            platform,
            spec.surface_handle,
            surface,
            &spec.plugin,
            &spec.page,
            spec.visible,
            spec.start,
        )
    })
}

#[cfg(test)]
#[path = "view_reload_test.rs"]
mod view_reload_test;
