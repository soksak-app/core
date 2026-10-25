use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::value::RawValue;

use super::{
    Failure, ImageEnvelopeDecision, Message, Owner, ResponseError, ResponseSender,
    try_handle_image_envelope,
};

#[derive(Clone)]
struct FixtureOwner {
    registered_surfaces: Arc<Mutex<HashSet<String>>>,
    registered_decision: ImageEnvelopeDecision,
}

impl Owner for FixtureOwner {
    fn key(&self) -> String {
        "fixture-window".into()
    }

    fn root(&self) -> Result<String, String> {
        Ok("fixture-project".into())
    }

    fn deliver(&self, _message: Message) {}

    fn deliver_failure(&self, failure: Failure) {
        panic!("unexpected sidecar failure: {failure:?}");
    }

    fn decide_image_envelope(
        &self,
        _sidecar_name: &str,
        _surface: &str,
        _body: &RawValue,
        _response_sender: &dyn ResponseSender,
    ) -> ImageEnvelopeDecision {
        if self.registered_surfaces.lock().unwrap().contains(_surface) {
            self.registered_decision
        } else {
            ImageEnvelopeDecision::OwnerRetired
        }
    }
}

#[derive(Default)]
struct Responses(Mutex<Vec<(String, String, String)>>);

impl ResponseSender for Responses {
    fn send(&self, surface: &str, image: &str, body: &RawValue) -> Result<(), ResponseError> {
        self.0
            .lock()
            .unwrap()
            .push((surface.into(), image.into(), body.get().into()));
        Ok(())
    }
}

#[test]
fn an_image_routed_to_an_owner_retired_after_lookup_receives_the_closed_answer() {
    let registered_surfaces = Arc::new(Mutex::new(HashSet::from(["surface-1".to_string()])));
    let owner = FixtureOwner {
        registered_surfaces: Arc::clone(&registered_surfaces),
        registered_decision: ImageEnvelopeDecision::NotImage,
    };
    let mut owners = HashMap::from([("surface-1".to_string(), owner)]);

    // The sidecar reader has already resolved the owner when window destruction removes its record.
    let routed_owner = owners.get("surface-1").unwrap().clone();
    owners.remove("surface-1");
    registered_surfaces.lock().unwrap().remove("surface-1");

    let body = RawValue::from_string(
        serde_json::json!({"image": {
            "name": "view",
            "token": {"kind": "iosurface-global", "id": 1, "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="},
            "width": 1,
            "height": 1,
            "scale": 1.0,
            "format": "bgra8",
            "generation": 1,
            "raster": 1,
            "sequence": 1
        }})
        .to_string(),
    )
    .unwrap();
    let responses = Responses::default();

    let handled = try_handle_image_envelope(
        &routed_owner,
        "@fixture/sidecar-image",
        "surface-1",
        &body,
        &responses,
    );

    assert!(handled, "a retired owner must consume its transfer image");
    assert_eq!(
        *responses.0.lock().unwrap(),
        vec![(
            "surface-1".into(),
            "view".into(),
            r#"{"image":{"error":"closed","generation":1,"name":"view","raster":1,"sequence":1}}"#
                .into(),
        )],
    );
}

#[test]
fn current_and_retired_owner_paths_keep_their_existing_dispositions() {
    let registered_surfaces = Arc::new(Mutex::new(HashSet::from(["surface-1".to_string()])));
    let responses = Responses::default();
    let non_image = RawValue::from_string(r#"{"event":"fixture"}"#.into()).unwrap();
    let live_owner = FixtureOwner {
        registered_surfaces: Arc::clone(&registered_surfaces),
        registered_decision: ImageEnvelopeDecision::NotImage,
    };

    assert!(!try_handle_image_envelope(
        &live_owner,
        "@fixture/sidecar-image",
        "surface-1",
        &non_image,
        &responses,
    ));
    assert!(responses.0.lock().unwrap().is_empty());

    let live_handled_owner = FixtureOwner {
        registered_surfaces: Arc::clone(&registered_surfaces),
        registered_decision: ImageEnvelopeDecision::Handled,
    };
    let image = RawValue::from_string(
        serde_json::json!({"image": {
            "name": "view",
            "token": {"kind": "iosurface-global", "id": 1, "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="},
            "width": 1,
            "height": 1,
            "scale": 1.0,
            "format": "bgra8",
            "generation": 1,
            "raster": 1,
            "sequence": 1
        }})
        .to_string(),
    )
    .unwrap();
    assert!(try_handle_image_envelope(
        &live_handled_owner,
        "@fixture/sidecar-image",
        "surface-1",
        &image,
        &responses,
    ));
    assert!(responses.0.lock().unwrap().is_empty());

    registered_surfaces.lock().unwrap().remove("surface-1");
    assert!(try_handle_image_envelope(
        &live_owner,
        "@fixture/sidecar-image",
        "surface-1",
        &non_image,
        &responses,
    ));
    let malformed_image = RawValue::from_string(r#"{"image":{"name":17}}"#.into()).unwrap();
    assert!(try_handle_image_envelope(
        &live_owner,
        "@fixture/sidecar-image",
        "surface-1",
        &malformed_image,
        &responses,
    ));
    assert!(responses.0.lock().unwrap().is_empty());
}
