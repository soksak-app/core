//! The document reference observation of a diagnostic build (docs/spec/document-reference.md): one native observation of an
//! exact attached document of a surface, bound to the document identity source of the active capture.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::framework::{Manager, Window};
use serde_json::{Map, Value, json};

use super::{
    CaptureDocumentIdentityRequest, await_document_observation, internal, start_document_identity,
};
use crate::endpoint::Failure;
use crate::exposure::on_main;
use crate::platform;
use crate::workspace::Workspace;

/// The largest JavaScript safe integer, the upper bound of a request ID.
const MAX_REQUEST_ID: u64 = 9_007_199_254_740_991;

/// A checked document reference request: the surface, the exact document name (`""` for the root) and the request ID.
#[derive(Debug, PartialEq)]
struct DocumentReferenceRequest {
    surface: String,
    document: String,
    request_id: u64,
}

/// Checks the parameters of a document reference request before any window or platform work.
fn parse_request(params: &Map<String, Value>) -> Result<DocumentReferenceRequest, Failure> {
    if params
        .keys()
        .any(|key| !["window", "surface", "document", "requestId"].contains(&key.as_str()))
    {
        return Err(Failure::params(
            "document reference parameters contain an undeclared field",
        ));
    }
    let surface = params
        .get("surface")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Failure::params("document reference requires a surface"))?;
    let document = params
        .get("document")
        .and_then(Value::as_str)
        .filter(|name| name.is_empty() || crate::documents::valid_name(name))
        .ok_or_else(|| {
            Failure::params(
                "document reference requires an exact document name (empty for the root)",
            )
        })?;
    let request_id = params
        .get("requestId")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= MAX_REQUEST_ID)
        .ok_or_else(|| {
            Failure::params(
                "document reference requestId must be a positive JavaScript safe integer",
            )
        })?;
    Ok(DocumentReferenceRequest {
        surface: surface.to_string(),
        document: document.to_string(),
        request_id,
    })
}

/// Observes the exact attached document of the request once and returns the native result with the identity start, the
/// generation, the target and the private artifact directory.
pub(super) fn capture(window: &Window, params: &Map<String, Value>) -> Result<Value, Failure> {
    let DocumentReferenceRequest {
        surface,
        document,
        request_id,
    } = parse_request(params)?;
    let held = window.clone();
    let key = (surface.clone(), document.clone());
    let (generation, expected_handle) = on_main(window, move || {
        let data = crate::windows::window_data(&held)?;
        let generation = data
            .view_source_origins
            .current_view(&key.0)
            .ok_or("document reference surface has no current renderer view")?;
        let handle = data.documents.get(&key)?;
        Ok((generation, handle))
    })
    .map_err(internal)?;
    let identity_start = start_document_identity(
        window,
        CaptureDocumentIdentityRequest {
            surface: surface.clone(),
            generation,
        },
        Some((document.clone(), expected_handle)),
    )?;
    let platform = platform::current().map_err(internal)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(internal)?
        .as_nanos();
    let directory = window
        .state::<Workspace>()
        .directory()
        .join("logs")
        .join("captures")
        .join(format!("document-reference-{request_id}-{stamp}"));
    platform.private_directory(&directory).map_err(internal)?;
    let captured_directory = directory.to_string_lossy().to_string();
    let held = window.clone();
    let key = (surface.clone(), document.clone());
    let raw = await_document_observation(window, "document reference", move |done| {
        let data = crate::windows::window_data(&held)?;
        if data.view_source_origins.current_view(&key.0) != Some(generation) {
            return Err("document reference renderer incarnation changed".into());
        }
        let handle = data.documents.get(&key)?;
        if handle != expected_handle {
            return Err("document reference native target was replaced".into());
        }
        platform.document_reference_observe(handle, request_id, &captured_directory, done)
    })
    .map_err(|error| {
        internal(format!(
            "document reference artifacts retained at {}: {error}",
            directory.display()
        ))
    })?;
    let mut value: Value = serde_json::from_str(&raw)
        .map_err(|error| internal(format!("document reference returned invalid JSON: {error}")))?;
    let fields = value
        .as_object_mut()
        .ok_or_else(|| internal("document reference result is not an object"))?;
    if fields.get("requestId").and_then(Value::as_u64) != Some(request_id) {
        return Err(internal(
            "document reference result belongs to another request",
        ));
    }
    fields.insert(
        "target".into(),
        json!({"surface":surface,"document":document}),
    );
    fields.insert("directory".into(), json!(directory.to_string_lossy()));
    fields.insert("identityStart".into(), identity_start);
    fields.insert("generation".into(), json!(generation));
    Ok(value)
}

#[cfg(test)]
#[path = "document_reference_test.rs"]
mod document_reference_test;

#[cfg(test)]
#[path = "document_reference_lifetime_test.rs"]
mod document_reference_lifetime_test;
