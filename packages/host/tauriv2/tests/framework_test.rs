//! Checks the framework port of the Tauri framework adapter (docs/spec/hosts.md#mygo-host).

use soksak_host::framework::WindowEvent;
use soksak_host_tauriv2::{Framework, Frontend};

fn implements_framework<T: soksak_host::Framework>() {}
fn implements_frontend<T: soksak_host::Frontend>() {}

// The build of the tests fails when the adapter does not implement the framework port.
const _: fn() = || {
    implements_framework::<Framework>();
    implements_frontend::<Frontend>();
};

// contract: application.framework.names-the-application
#[test]
fn the_tauri_framework_names_the_application_of_the_endpoint() {
    assert_eq!(
        soksak_host::Framework::application_name(&Framework),
        "tauriv2"
    );
    assert_eq!(soksak_host::Framework::display_name(&Framework), "Tauri v2");
}

// contract: application.framework.window-events-are-port-events
#[test]
fn each_window_event_of_tauri_is_an_event_of_the_frontend() {
    let size = tauri::PhysicalSize::new(1, 2);
    let position = tauri::PhysicalPosition::new(3, 4);
    assert!(matches!(
        soksak_host_tauriv2::window_event(&tauri::WindowEvent::Resized(size)),
        Some(WindowEvent::Resized(soksak_host::framework::PhysicalSize {
            width: 1,
            height: 2
        }))
    ));
    assert!(matches!(
        soksak_host_tauriv2::window_event(&tauri::WindowEvent::Moved(position)),
        Some(WindowEvent::Moved(
            soksak_host::framework::PhysicalPosition { x: 3, y: 4 }
        ))
    ));
    assert!(matches!(
        soksak_host_tauriv2::window_event(&tauri::WindowEvent::Focused(true)),
        Some(WindowEvent::Focused(true))
    ));
    assert!(matches!(
        soksak_host_tauriv2::window_event(&tauri::WindowEvent::Focused(false)),
        Some(WindowEvent::Focused(false))
    ));
    assert!(matches!(
        soksak_host_tauriv2::window_event(&tauri::WindowEvent::Destroyed),
        Some(WindowEvent::Destroyed)
    ));
}

// contract: binding.reply.absent-value-is-null
#[test]
fn a_binding_call_without_a_value_replies_null() {
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    // A command result is serialized by IpcResponse, so no value and a null value reply the JSON value null.
    let replies = [
        ().body().unwrap(),
        serde_json::Value::Null.body().unwrap(),
        None::<String>.body().unwrap(),
    ];
    for reply in replies {
        match reply {
            InvokeResponseBody::Json(text) => assert_eq!(text, "null"),
            InvokeResponseBody::Raw(bytes) => panic!("raw reply of {} bytes", bytes.len()),
        }
    }
}

// contract: installed.shared.serve-extension-point-modules
#[test]
fn the_web_view_protocol_serves_a_shared_module_as_javascript() {
    // The protocol of the webview takes the MIME type from the path, so the path of a shared module ends in .js.
    assert_eq!(
        tauri::utils::mime_type::MimeType::parse(
            b"export const state = 1;",
            "/shared/alpha.language/@codemirror/state.js"
        ),
        "text/javascript"
    );
}
