use std::os::unix::fs::PermissionsExt;
use std::sync::mpsc::{self, Receiver, Sender, sync_channel};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::value::RawValue;

use super::super::{
    Failure, ImageDetachWaiter, Message, Owner, ResponseError, ResponseSender, SidecarDeclaration,
    Sidecars, try_handle_image_envelope,
};
use super::{DetachOutcome, DetachWait, begin_image_detaches};
use crate::event_record::buffered_fields;
use crate::images::Images;

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
    failures: Sender<Failure>,
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
        self.failures
            .send(failure)
            .expect("the fake supplier test keeps its failure receiver alive");
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
    failures: Receiver<Failure>,
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
    let (failure_sender, failures) = mpsc::channel();
    let owner = SupplierOwner {
        manager: Arc::new(Mutex::new(Weak::new())),
        messages: sender,
        failures: failure_sender,
    };
    let sidecars = Arc::new(Sidecars::new(&declarations, config.path().to_path_buf()).unwrap());
    *owner.manager.lock().unwrap() = Arc::downgrade(&sidecars);
    Fixture {
        _executable: executable,
        _config: config,
        sidecars,
        owner,
        messages,
        failures,
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

/// A supplier that reads one request and exits without an acknowledgement.
fn exiting_supplier() -> &'static str {
    "#!/bin/sh\nIFS= read -r request\n"
}

fn manager() -> (tempfile::TempDir, Sidecars<TestOwner>) {
    let config = tempfile::tempdir().unwrap();
    let sidecars = Sidecars::new(&[], config.path().to_path_buf()).unwrap();
    (config, sidecars)
}

fn pending(sidecars: &Sidecars<impl Owner>, request: &str) -> Receiver<DetachOutcome> {
    let (sender, receiver) = sync_channel(1);
    sidecars.core.state.lock().unwrap().image_detaches.insert(
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

        assert!(
            try_handle_image_envelope(
                &fixture.owner,
                "fixture-sidecar",
                "surface-a",
                &body,
                &NoopResponseSender,
            ),
            "deep unrelated member location {index} must not hide the acknowledgement"
        );
        assert_eq!(
            response
                .try_recv()
                .expect("the acknowledgement settles synchronously"),
            DetachOutcome::Detached,
            "deep unrelated member location {index} must settle its exact waiter"
        );
    }
}

fn has_waiter(sidecars: &Sidecars<impl Owner>, request: &str) -> bool {
    sidecars
        .core
        .state
        .lock()
        .unwrap()
        .image_detaches
        .contains_key(request)
}

/// The request id of the pending detach of image name.
fn pending_request(sidecars: &Sidecars<impl Owner>, name: &str) -> String {
    sidecars
        .core
        .state
        .lock()
        .unwrap()
        .image_detaches
        .iter()
        .find(|(_, waiter)| waiter.name == name)
        .map(|(request, _)| request.clone())
        .unwrap_or_else(|| panic!("image {name} has no pending detach request"))
}

fn acknowledge(
    fixture: &Fixture,
    sidecar: &str,
    request: &str,
    name: &str,
    generation: u64,
    fields: serde_json::Value,
) {
    let mut detached =
        serde_json::json!({"request": request, "name": name, "generation": generation});
    for (key, value) in fields.as_object().unwrap() {
        detached[key] = value.clone();
    }
    fixture
        .sidecars
        .acknowledge_image_detach(
            sidecar,
            "surface-a",
            &ack(serde_json::json!({"image":{"detached": detached}})),
        )
        .unwrap();
}

/// Images with one attached image of surface-a for each (sidecar, name), and the page ready for ended events.
fn images_with(regions: &[(&str, &str)]) -> Images {
    let images = Images::default();
    images.begin_generation("surface-a");
    for (index, (sidecar, name)) in regions.iter().enumerate() {
        let key = ("surface-a".to_string(), (*name).to_string());
        images.reserve(&key, "owner", sidecar).unwrap();
        assert!(images.set(&key, index + 1));
    }
    images.detach_page_ready();
    images
}

fn ended_events() -> (super::EndedEvent, Receiver<serde_json::Value>) {
    let (sender, receiver) = mpsc::channel();
    let sender = Mutex::new(sender);
    (
        Arc::new(move |event| sender.lock().unwrap().send(event).unwrap()),
        receiver,
    )
}

/// The image-detach-ended event of surface-a with error.
fn ended(error: Option<String>) -> serde_json::Value {
    serde_json::json!({"surface": "surface-a", "error": error})
}

fn join(waits: Vec<DetachWait>) {
    for wait in waits {
        wait.thread.join().unwrap();
    }
}

fn errors_naming(request: &str) -> Vec<String> {
    buffered_fields("host.record.error")
        .into_iter()
        .filter(|fields| {
            fields["text"]
                .as_str()
                .is_some_and(|text| text.contains(request))
        })
        .map(|fields| {
            format!(
                "{}: {}",
                fields["where"].as_str().unwrap(),
                fields["text"].as_str().unwrap()
            )
        })
        .collect()
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

    assert_eq!(receiver.recv().unwrap(), DetachOutcome::Detached);
    assert_eq!(
        sidecars
            .acknowledge_image_detach("fixture-sidecar", "surface-a", &body)
            .unwrap_err(),
        r#"image detach acknowledgement has no pending request "request-a" for surface surface-a"#
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

    assert_eq!(
        sidecars
            .acknowledge_image_detach("fixture-sidecar", "surface-a", &body)
            .unwrap_err(),
        r#"image detach acknowledgement "request-a" does not match its owner, surface, name, or generation"#
    );

    assert!(receiver.try_recv().is_err());
    assert!(has_waiter(&sidecars, "request-a"));
    assert!(has_waiter(&sidecars, "request-b"));

    let exact = ack(serde_json::json!({"image":{"detached":{
        "request":"request-a", "name":"region-a", "generation":7,
        "ok":true, "result":"detached"
    }}}));
    sidecars
        .acknowledge_image_detach("fixture-sidecar", "surface-a", &exact)
        .unwrap();
    assert_eq!(receiver.recv().unwrap(), DetachOutcome::Detached);
    drop(other);
}

// contract: images.detach.ack-exact-owner
#[test]
fn an_invalid_detach_acknowledgement_keeps_its_waiter() {
    let (_config, sidecars) = manager();
    let receiver = pending(&sidecars, "request-a");
    let invalid_success = ack(serde_json::json!({"image":{"detached":{
        "request":"request-a", "name":"region-a", "generation":7, "ok":true, "result":"gone"
    }}}));
    let reasonless_failure = ack(serde_json::json!({"image":{"detached":{
        "request":"request-a", "name":"region-a", "generation":7, "ok":false
    }}}));

    assert_eq!(
        sidecars
            .acknowledge_image_detach("fixture-sidecar", "surface-a", &invalid_success)
            .unwrap_err(),
        r#"invalid successful image detach acknowledgement "request-a" for surface surface-a"#
    );
    assert_eq!(
        sidecars
            .acknowledge_image_detach("fixture-sidecar", "surface-a", &reasonless_failure)
            .unwrap_err(),
        r#"failed image detach acknowledgement "request-a" has no error for surface surface-a"#
    );
    assert!(receiver.try_recv().is_err());
    assert!(has_waiter(&sidecars, "request-a"));
}

// contract: images.detach.refusal-ends-pending
#[test]
fn a_rejected_detach_acknowledgement_ends_the_wait_with_the_supplier_reason() {
    let (_config, sidecars) = manager();
    let receiver = pending(&sidecars, "request-a");
    let body = ack(serde_json::json!({"image":{"detached":{
        "request":"request-a", "name":"region-a", "generation":7,
        "ok":false, "error":"staleGeneration", "currentGeneration": 8
    }}}));

    sidecars
        .acknowledge_image_detach("fixture-sidecar", "surface-a", &body)
        .unwrap();
    assert_eq!(
        receiver.recv().unwrap(),
        DetachOutcome::Rejected("staleGeneration (current generation 8)".to_string())
    );
}

// contract: images.reload.start-sends-detach-without-waiting, images.detach.surface-ends-after-its-last-detach, images.detach.ack-consumed
#[test]
fn a_surface_ends_its_detaches_only_after_the_acknowledgement_of_each_of_its_images() {
    let fixture = fixture(
        silent_supplier(),
        &["@fixture/sidecar-one", "@fixture/sidecar-two"],
    );
    let images = images_with(&[
        ("@fixture/sidecar-one", "region-one"),
        ("@fixture/sidecar-two", "region-two"),
    ]);
    let targets = images.begin_reload("surface-a");
    let (ended_event, ended_events) = ended_events();

    let waits = begin_image_detaches(
        &fixture.sidecars,
        &fixture.owner,
        &images,
        targets.clone(),
        Duration::from_secs(60),
        ended_event,
    )
    .unwrap();
    let pending = images.pending_detach_error("surface-a").unwrap_err();
    assert!(
        pending.starts_with("image detach sidecar @fixture/sidecar-one surface surface-a image region-one generation")
            && pending.ends_with("is pending"),
        "the start returned before the acknowledgements and leaves the surface pending: {pending}"
    );

    let first = pending_request(&fixture.sidecars, "region-one");
    acknowledge(
        &fixture,
        "@fixture/sidecar-one",
        &first,
        "region-one",
        targets[0].generation,
        serde_json::json!({"ok": true, "result": "detached"}),
    );
    let mut waits = waits.into_iter();
    waits.next().unwrap().thread.join().unwrap();
    let pending = images.pending_detach_error("surface-a").unwrap_err();
    assert!(
        pending.contains("image region-two"),
        "the second image stays pending: {pending}"
    );
    assert!(
        ended_events.try_recv().is_err(),
        "the surface sent an ended event with one of two detaches pending"
    );

    let second = pending_request(&fixture.sidecars, "region-two");
    acknowledge(
        &fixture,
        "@fixture/sidecar-two",
        &second,
        "region-two",
        targets[1].generation,
        serde_json::json!({"ok": true, "result": "alreadyAbsent"}),
    );
    join(waits.collect());
    assert_eq!(ended_events.try_recv().unwrap(), ended(None));
    assert_eq!(images.pending_detach_error("surface-a"), Ok(()));
    fixture.sidecars.stop();
}

// contract: images.detach.timeout-keeps-waiting
#[test]
fn a_timed_out_detach_is_recorded_once_and_a_late_acknowledgement_ends_it() {
    let fixture = fixture(silent_supplier(), &["@fixture/sidecar-one"]);
    let images = images_with(&[("@fixture/sidecar-one", "region-timeout")]);
    let targets = images.begin_reload("surface-a");
    let (ended_event, ended_events) = ended_events();

    let mut waits = begin_image_detaches(
        &fixture.sidecars,
        &fixture.owner,
        &images,
        targets.clone(),
        Duration::from_millis(20),
        ended_event,
    )
    .unwrap();
    let request = pending_request(&fixture.sidecars, "region-timeout");
    assert_eq!(
        waits[0].timed_out.recv_timeout(Duration::from_secs(5)),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected),
        "the wait recorded no timeout"
    );
    assert!(
        images.pending_detach_error("surface-a").is_err(),
        "the surface stopped waiting at the timeout"
    );
    assert!(
        images.begin_reload("surface-a").is_empty(),
        "a reload sends no second detach for a pending image"
    );

    acknowledge(
        &fixture,
        "@fixture/sidecar-one",
        &request,
        "region-timeout",
        targets[0].generation,
        serde_json::json!({"ok": true, "result": "detached"}),
    );
    waits.pop().unwrap().thread.join().unwrap();
    assert_eq!(ended_events.try_recv().unwrap(), ended(None));
    assert_eq!(
        errors_naming(&request),
        [format!(
            "image detach: image detach sidecar @fixture/sidecar-one surface surface-a image region-timeout generation {} request {request} timed out",
            targets[0].generation
        )]
    );
    fixture.sidecars.stop();
}

// contract: images.detach.refusal-ends-pending
#[test]
fn a_rejected_detach_ends_the_pending_detach_with_its_error_in_the_ended_event() {
    let fixture = fixture(silent_supplier(), &["@fixture/sidecar-one"]);
    let images = images_with(&[("@fixture/sidecar-one", "region-rejected")]);
    let targets = images.begin_reload("surface-a");
    let (ended_event, ended_events) = ended_events();

    let waits = begin_image_detaches(
        &fixture.sidecars,
        &fixture.owner,
        &images,
        targets.clone(),
        Duration::from_secs(60),
        ended_event,
    )
    .unwrap();
    let request = pending_request(&fixture.sidecars, "region-rejected");
    acknowledge(
        &fixture,
        "@fixture/sidecar-one",
        &request,
        "region-rejected",
        targets[0].generation,
        serde_json::json!({"ok": false, "error": "staleGeneration", "currentGeneration": 99}),
    );
    join(waits);

    assert_eq!(images.pending_detach_error("surface-a"), Ok(()));
    assert_eq!(
        ended_events.try_recv().unwrap(),
        ended(Some(format!(
            "image detach sidecar @fixture/sidecar-one surface surface-a image region-rejected generation {} request {request} rejected: staleGeneration (current generation 99)",
            targets[0].generation
        )))
    );
    // The page shows the rejection through its error display, which writes its one record.
    assert!(errors_naming(&request).is_empty());
    fixture.sidecars.stop();
}

// contract: images.detach.session-end-releases
#[test]
fn the_end_of_the_surface_session_ends_its_pending_detach_without_an_ended_event() {
    let fixture = fixture(silent_supplier(), &["@fixture/sidecar-one"]);
    let images = images_with(&[("@fixture/sidecar-one", "region-closed")]);
    let targets = images.begin_reload("surface-a");
    let (ended_event, ended_events) = ended_events();

    let waits = begin_image_detaches(
        &fixture.sidecars,
        &fixture.owner,
        &images,
        targets,
        Duration::from_secs(60),
        ended_event,
    )
    .unwrap();
    fixture
        .sidecars
        .close_owned(&fixture.owner, &|surface| surface == "surface-a")
        .unwrap();
    join(waits);

    assert_eq!(images.pending_detach_error("surface-a"), Ok(()));
    assert!(
        ended_events.try_recv().is_err(),
        "a released detach sent an ended event"
    );
    fixture.sidecars.stop();
}

// contract: images.detach.session-end-releases
#[test]
fn the_end_of_the_supplier_connection_ends_its_pending_detach_with_its_error() {
    let fixture = fixture(exiting_supplier(), &["@fixture/sidecar-one"]);
    let images = images_with(&[("@fixture/sidecar-one", "region-failed")]);
    let targets = images.begin_reload("surface-a");
    let (ended_event, ended_events) = ended_events();

    let waits = begin_image_detaches(
        &fixture.sidecars,
        &fixture.owner,
        &images,
        targets.clone(),
        Duration::from_secs(60),
        ended_event,
    )
    .unwrap();
    let request = pending_request(&fixture.sidecars, "region-failed");
    join(waits);

    assert_eq!(images.pending_detach_error("surface-a"), Ok(()));
    assert_eq!(
        ended_events.try_recv().unwrap(),
        ended(Some(format!(
            "image detach sidecar @fixture/sidecar-one surface surface-a image region-failed generation {} request {request} ended: the supplier connection ended",
            targets[0].generation
        )))
    );
    let failure = fixture
        .failures
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert_eq!(
        (failure.sidecar.as_str(), failure.surface.as_str()),
        ("@fixture/sidecar-one", "surface-a")
    );
    fixture.sidecars.stop();
}

// contract: images.detach.ack-consumed
#[test]
fn a_supplier_acknowledgement_is_consumed_by_the_host_and_ends_the_detach() {
    let fixture = fixture(acknowledged_supplier(), &["@fixture/sidecar-one"]);
    let images = images_with(&[("@fixture/sidecar-one", "region-one")]);
    let targets = images.begin_reload("surface-a");
    let (ended_event, ended_events) = ended_events();

    let waits = begin_image_detaches(
        &fixture.sidecars,
        &fixture.owner,
        &images,
        targets,
        Duration::from_secs(60),
        ended_event,
    )
    .unwrap();
    join(waits);

    assert_eq!(ended_events.try_recv().unwrap(), ended(None));
    let event = fixture
        .messages
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let message = serde_json::from_str::<serde_json::Value>(event.body.get()).unwrap();
    assert_eq!(
        message,
        serde_json::json!({"event": "after-detach", "name": "region-one"})
    );
    assert!(
        fixture.messages.try_recv().is_err(),
        "the acknowledgement reached the page"
    );
    fixture.sidecars.stop();
}
