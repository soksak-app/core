use std::os::unix::fs::PermissionsExt;
use std::sync::mpsc::{self, Receiver, Sender, sync_channel};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::value::RawValue;

use super::super::{
    Failure, ImageDetachWaiter, Message, Owner, ResponseError, ResponseSender, SidecarDeclaration,
    Sidecars, try_handle_image_envelope,
};

#[derive(Clone)]
struct TestOwner;

impl Owner for TestOwner {
    fn key(&self) -> String {
        "window-test".to_string()
    }
    fn root(&self) -> Result<String, String> {
        Ok("/project".to_string())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, _failure: Failure) {}
}

#[derive(Clone)]
struct SupplierOwner {
    manager: Arc<Mutex<Weak<Sidecars<SupplierOwner>>>>,
    messages: Sender<Message>,
}

impl Owner for SupplierOwner {
    fn key(&self) -> String {
        "window-detach-test".to_string()
    }
    fn root(&self) -> Result<String, String> {
        Ok("/project".to_string())
    }
    fn deliver(&self, message: Message) {
        self.messages
            .send(message)
            .expect("the fake supplier test keeps its message receiver alive");
    }
    fn deliver_failure(&self, failure: Failure) {
        panic!("unexpected sidecar failure: {failure:?}");
    }
    fn image_detach_ack(
        &self,
        sidecar: &str,
        surface: &str,
        body: &RawValue,
    ) -> Result<(), String> {
        self.manager
            .lock()
            .unwrap()
            .upgrade()
            .ok_or_else(|| "sidecar manager ended before its acknowledgement".to_string())?
            .acknowledge_image_detach(sidecar, surface, body)
    }
}

struct Fixture {
    _executable: tempfile::TempDir,
    _config: tempfile::TempDir,
    sidecars: Arc<Sidecars<SupplierOwner>>,
    owner: SupplierOwner,
    messages: Receiver<Message>,
}

fn fixture(script: &str, names: &[&str]) -> Fixture {
    let executable = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let program = executable.path().join("echo");
    std::fs::write(&program, script).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let declarations: Vec<_> = names
        .iter()
        .map(|name| SidecarDeclaration {
            name: (*name).to_string(),
            folder: executable.path().to_path_buf(),
            data: br#"{"executable":"echo","protocol":1,"displayName":"soksak://sidecar/probe"}"#
                .to_vec(),
            version: "0.0.1".to_string(),
            dependents: Vec::new(),
        })
        .collect();
    let (sender, messages) = mpsc::channel();
    let owner = SupplierOwner {
        manager: Arc::new(Mutex::new(Weak::new())),
        messages: sender,
    };
    let sidecars = Arc::new(Sidecars::new(&declarations, config.path().to_path_buf()).unwrap());
    *owner.manager.lock().unwrap() = Arc::downgrade(&sidecars);
    Fixture {
        _executable: executable,
        _config: config,
        sidecars,
        owner,
        messages,
    }
}

fn acknowledged_supplier() -> &'static str {
    r##"#!/bin/sh
while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"request":"\([^"]*\)".*/\1/p')
  name=$(printf '%s' "$request" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
  generation=$(printf '%s' "$request" | sed -n 's/.*"generation":\([0-9]*\).*/\1/p')
  printf '{"surface":"surface-a","body":{"image":{"detached":{"request":"%s","name":"%s","generation":%s,"ok":true,"result":"detached"}}}}\n' "$id" "$name" "$generation"
  printf '{"surface":"surface-a","body":{"event":"after-detach","name":"%s"}}\n' "$name"
done
"##
}

fn silent_supplier() -> &'static str {
    "#!/bin/sh\nwhile IFS= read -r request; do :; done\n"
}

fn target(sidecar: &str, name: &str, generation: u64) -> crate::images::DetachTarget {
    crate::images::DetachTarget {
        surface: "surface-a".to_string(),
        name: name.to_string(),
        sidecar: sidecar.to_string(),
        generation,
    }
}

fn manager() -> (tempfile::TempDir, Sidecars<TestOwner>) {
    let config = tempfile::tempdir().unwrap();
    let sidecars = Sidecars::new(&[], config.path().to_path_buf()).unwrap();
    (config, sidecars)
}

fn pending(
    sidecars: &Sidecars<impl Owner>,
    request: &str,
) -> std::sync::mpsc::Receiver<Result<(), String>> {
    let (sender, receiver) = sync_channel(1);
    sidecars.core.image_detaches.lock().unwrap().insert(
        request.to_string(),
        ImageDetachWaiter {
            sidecar: "fixture-sidecar".to_string(),
            surface: "surface-a".to_string(),
            name: "region-a".to_string(),
            generation: 7,
            result: sender,
        },
    );
    receiver
}

struct NoopResponseSender;

impl ResponseSender for NoopResponseSender {
    fn send(&self, _surface: &str, _image: &str, _body: &RawValue) -> Result<(), ResponseError> {
        Ok(())
    }
}

fn ack(value: serde_json::Value) -> Box<RawValue> {
    RawValue::from_string(value.to_string()).unwrap()
}

// contract: images.detach.ack-consumed
#[test]
fn a_deep_unrelated_member_does_not_hide_a_detach_acknowledgement() {
    let nested = format!("{}0{}", "[".repeat(140), "]".repeat(140));
    let cases = [
        format!(
            r#"{{"image":{{"detached":{{"request":"request-a","name":"region-a","generation":7,"ok":true,"result":"detached"}}}},"metadata":{nested}}}"#
        ),
        format!(
            r#"{{"image":{{"detached":{{"request":"request-a","name":"region-a","generation":7,"ok":true,"result":"detached"}},"metadata":{nested}}}}}"#
        ),
        format!(
            r#"{{"image":{{"detached":{{"request":"request-a","name":"region-a","generation":7,"ok":true,"result":"detached","metadata":{nested}}}}}}}"#
        ),
    ];

    for (index, raw_body) in cases.into_iter().enumerate() {
        let fixture = fixture(silent_supplier(), &["fixture-sidecar"]);
        let request = format!("request-{index}");
        let response = pending(&fixture.sidecars, &request);
        let raw_body = raw_body.replace("request-a", &request);
        let body = RawValue::from_string(raw_body)
            .expect("the fixture is valid JSON with an unrelated deep member");

        assert!(try_handle_image_envelope(
            &fixture.owner,
            "fixture-sidecar",
            "surface-a",
            &body,
            &NoopResponseSender,
        ), "deep unrelated member location {index} must not hide the acknowledgement");
        assert_eq!(
            response.try_recv().expect("the acknowledgement settles synchronously"),
            Ok(()),
            "deep unrelated member location {index} must settle its exact waiter"
        );
    }
}

// contract: images.detach.ack-exact-owner
#[test]
fn an_exact_detach_acknowledgement_settles_its_request_once() {
    let (_config, sidecars) = manager();
    let receiver = pending(&sidecars, "request-a");
    let body = ack(serde_json::json!({"image":{"detached":{
        "request":"request-a", "name":"region-a", "generation":7,
        "ok":true, "result":"detached"
    }}}));

    sidecars
        .acknowledge_image_detach("fixture-sidecar", "surface-a", &body)
        .unwrap();

    assert_eq!(receiver.recv().unwrap(), Ok(()));
    assert!(
        sidecars
            .acknowledge_image_detach("fixture-sidecar", "surface-a", &body)
            .unwrap_err()
            .contains("no pending request")
    );
}

// contract: images.detach.ack-exact-owner
#[test]
fn a_mismatched_detach_acknowledgement_keeps_its_waiter_for_the_exact_acknowledgement() {
    let (_config, sidecars) = manager();
    let receiver = pending(&sidecars, "request-a");
    let other = pending(&sidecars, "request-b");
    let body = ack(serde_json::json!({"image":{"detached":{
        "request":"request-a", "name":"region-a", "generation":8,
        "ok":true, "result":"detached"
    }}}));

    assert!(
        sidecars
            .acknowledge_image_detach("fixture-sidecar", "surface-a", &body)
            .unwrap_err()
            .contains("does not match")
    );

    assert!(receiver.try_recv().is_err());
    assert!(
        sidecars
            .core
            .image_detaches
            .lock()
            .unwrap()
            .contains_key("request-a")
    );
    assert!(
        sidecars
            .core
            .image_detaches
            .lock()
            .unwrap()
            .contains_key("request-b")
    );

    let exact = ack(serde_json::json!({"image":{"detached":{
        "request":"request-a", "name":"region-a", "generation":7,
        "ok":true, "result":"detached"
    }}}));
    sidecars
        .acknowledge_image_detach("fixture-sidecar", "surface-a", &exact)
        .unwrap();
    assert_eq!(receiver.recv().unwrap(), Ok(()));
    drop(other);
}

// contract: images.detach.refusal-fails-start
#[test]
fn a_rejected_detach_acknowledgement_fails_page_start_with_the_supplier_reason() {
    let (_config, sidecars) = manager();
    let receiver = pending(&sidecars, "request-a");
    let body = ack(serde_json::json!({"image":{"detached":{
        "request":"request-a", "name":"region-a", "generation":7,
        "ok":false, "error":"imageNameMismatch"
    }}}));

    assert!(
        sidecars
            .acknowledge_image_detach("fixture-sidecar", "surface-a", &body)
            .unwrap_err()
            .contains("imageNameMismatch")
    );
    assert!(
        receiver
            .recv()
            .unwrap()
            .unwrap_err()
            .contains("imageNameMismatch")
    );
}

// contract: images.detach.waits-for-every-region, images.detach.ack-consumed
#[test]
fn detach_waits_for_every_region_and_consumes_supplier_acknowledgements() {
    let fixture = fixture(
        acknowledged_supplier(),
        &["@fixture/sidecar-one", "@fixture/sidecar-two"],
    );
    let targets = [
        target("@fixture/sidecar-one", "region-one", 7),
        target("@fixture/sidecar-one", "region-two", 7),
        target("@fixture/sidecar-two", "region-three", 9),
    ];

    fixture
        .sidecars
        .detach_images(&fixture.owner, &targets)
        .unwrap();

    let mut messages = Vec::new();
    for _ in 0..targets.len() {
        let event = fixture
            .messages
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        messages.push(serde_json::from_str::<serde_json::Value>(event.body.get()).unwrap());
    }
    messages.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    assert_eq!(messages.len(), 3);
    assert!(
        messages
            .iter()
            .all(|message| message["event"] == "after-detach")
    );
    assert_eq!(messages[0]["name"], "region-one");
    assert_eq!(messages[1]["name"], "region-three");
    assert_eq!(messages[2]["name"], "region-two");
    assert!(
        fixture
            .sidecars
            .core
            .image_detaches
            .lock()
            .unwrap()
            .is_empty()
    );
    fixture.sidecars.stop();
}

// contract: images.detach.timeout-retains-target
#[test]
fn a_detach_timeout_reports_its_target_and_removes_its_waiter() {
    let fixture = fixture(silent_supplier(), &["@fixture/sidecar-one"]);
    let targets = [target("@fixture/sidecar-one", "region-timeout", 11)];

    let error = fixture
        .sidecars
        .detach_images_until(&fixture.owner, &targets, Duration::from_millis(20))
        .unwrap_err();

    assert!(error.contains("surface-a/region-timeout"));
    assert!(error.contains("timed out"));
    assert!(
        fixture
            .sidecars
            .core
            .image_detaches
            .lock()
            .unwrap()
            .is_empty()
    );
    fixture.sidecars.stop();
}
