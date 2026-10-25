use serde_json::json;
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets},
    webview::{InvokeRequest, WebviewWindowBuilder},
};

// contract: plugin-host.starter.rejects-invalid-request
#[test]
fn plugins_starter_rejects_an_invalid_request_through_the_registered_handler() {
    let config = tempfile::tempdir().unwrap();
    let plugins = crate::plugins::Plugins::new(
        config.path().to_path_buf(),
        Box::new(|| Ok(())),
        Box::new(|_| {}),
    )
    .unwrap();
    assert!(super::command_names().contains(&"plugins_starter"));
    let app = mock_builder()
        .manage(plugins)
        .invoke_handler(tauri::generate_handler![super::plugins_starter])
        .build(mock_context(noop_assets()))
        .unwrap();
    let window = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let response = get_ipc_response(
        &window,
        InvokeRequest {
            cmd: "plugins_starter".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(json!({"request": {"state": 3}})),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    );
    assert_eq!(
        response.unwrap_err(),
        json!("argument request.state must be a string, not a number")
    );
}
