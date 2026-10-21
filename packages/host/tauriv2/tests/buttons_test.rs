//! Tests of the value of host.buttons and its notifications. A fake service replaces the window and the page of the
//! endpoint.

#[path = "support/folder.rs"]
mod folder;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Map, Value, json};
use soksak_host_tauriv2::buttons::Buttons;
use soksak_host_tauriv2::endpoint::{self, Connection, Endpoint, Failure, Service, raw};

/// A service that has only the window w1 and answers host.buttons with the value of buttons.
struct Fake {
    buttons: OnceLock<Arc<Buttons>>,
}

impl Service for Fake {
    fn unwatched(&self, _window: &str, _name: &str) {}

    fn windows(&self) -> Result<Value, Failure> {
        Ok(json!([{"window": "w1", "title": "one", "project": null, "key": true}]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "w1"
    }

    fn call(
        &self,
        _window: &str,
        method: &str,
        params: Map<String, Value>,
    ) -> Result<Box<serde_json::value::RawValue>, Failure> {
        match (method, params.get("name").and_then(Value::as_str)) {
            ("status.get", Some("host.buttons")) => raw(&self.buttons.get().unwrap().value()),
            _ => raw(&Value::Null),
        }
    }
}

fn start(config: &Path, service: Arc<Fake>) -> Endpoint {
    let endpoint =
        Endpoint::start(&config.join("sockets"), config, "test-buttons", service).unwrap();
    endpoint.publish("w1").unwrap();
    endpoint
}

fn request(connection: &mut Box<dyn Connection>, id: u64, method: &str, params: Value) -> Value {
    endpoint::write_frame(
        connection,
        &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )
    .unwrap();
    let reply = endpoint::read_frame(connection)
        .unwrap()
        .expect("the endpoint closed the connection");
    assert_eq!(
        reply["id"], id,
        "a notification arrived before the reply: {reply}"
    );
    reply
}

/// The mask of the next notification of host.buttons.
fn next_mask(connection: &mut Box<dyn Connection>) -> Value {
    let got = endpoint::read_frame(connection)
        .unwrap()
        .expect("no host.buttons notification");
    assert_eq!(got["method"], "status.changed", "{got}");
    assert_eq!(got["params"]["window"], "w1", "{got}");
    assert_eq!(got["params"]["name"], "host.buttons", "{got}");
    got["params"]["value"]["mask"].clone()
}

// contract: exposure.host-buttons.notifies-mask-change
#[test]
fn buttons_notify_each_mask_change() {
    let config = folder::Folder::new();
    let fake = Arc::new(Fake {
        buttons: OnceLock::new(),
    });
    let endpoint = start(config.path(), fake.clone());
    let notifier = endpoint.notifier();
    let buttons = Arc::new(Buttons::new(move |value| {
        notifier.notify_watchers("host.buttons", &raw(&value).unwrap())
    }));
    assert!(fake.buttons.set(buttons.clone()).is_ok());
    let mut connection = endpoint::connect(endpoint.address()).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let watch = json!({"window": "w1", "name": "host.buttons"});
    assert_eq!(
        request(&mut connection, 1, "status.watch", watch.clone())["result"],
        Value::Null
    );
    assert_eq!(
        request(&mut connection, 2, "status.get", watch.clone())["result"],
        json!({"mask": 0})
    );
    // A report of the same mask is not announced. The next notification is the next different mask.
    buttons.report(0);
    buttons.report(1);
    assert_eq!(next_mask(&mut connection), 1);
    buttons.report(1);
    buttons.report(3);
    buttons.report(0);
    assert_eq!(next_mask(&mut connection), 3);
    assert_eq!(next_mask(&mut connection), 0);
    // A remaining notification arrives before the answer to this request.
    assert_eq!(
        request(&mut connection, 3, "status.get", watch)["result"],
        json!({"mask": 0})
    );
    endpoint.stop();
}

// A panic while the state is held poisons the lock; the next report recovers the state and announces its value.
#[test]
fn a_poisoned_button_state_is_recovered_and_the_next_report_is_announced() {
    let announced: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let first = Arc::new(AtomicBool::new(true));
    let sink = Arc::clone(&announced);
    let panics_once = Arc::clone(&first);
    let buttons = Arc::new(Buttons::new(move |value| {
        if panics_once.swap(false, Ordering::SeqCst) {
            panic!("the first announcement panics while the state lock is held");
        }
        sink.lock().unwrap().push(value);
    }));
    let source = Arc::clone(&buttons);
    let poisoning = std::thread::spawn(move || source.report(1));
    assert!(poisoning.join().is_err(), "the first report must panic");
    buttons.report(2);
    assert_eq!(*announced.lock().unwrap(), vec![json!({"mask": 2})]);
    assert_eq!(buttons.value(), json!({"mask": 2}));
}
