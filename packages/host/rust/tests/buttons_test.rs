//! Tests of the value of host.buttons and its notifications. The page of the window is the page of an endpoint case
//! (support/endpoint_case.rs), and the window owner answers host.buttons with the value of the buttons.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/platform/platform.rs"]
mod endpoint_client;

#[path = "support/endpoint_case.rs"]
mod endpoint_case;

use endpoint_case::{CasePage, exchange};
use endpoint_client::Connection;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value, json};
use soksak_host::buttons::Buttons;
use soksak_host::endpoint::{self, Endpoint, Failure, Service, raw};

/// The window owner of the endpoint with the window main: it answers host.buttons with the value of buttons and gives every other
/// request to the page.
struct ButtonsOwner {
    page: Arc<CasePage>,
    buttons: OnceLock<Arc<Buttons>>,
}

impl Service for ButtonsOwner {
    fn unwatched(&self, window: &str, name: &str) {
        self.page.unwatched(window, name)
    }

    fn windows(&self) -> Result<Value, Failure> {
        self.page.windows()
    }

    fn exists(&self, window: &str) -> bool {
        self.page.exists(window)
    }

    fn call(
        &self,
        window: &str,
        method: &str,
        params: Map<String, Value>,
        reply: Option<soksak_host::endpoint::ReplyScope>,
    ) -> Result<Box<serde_json::value::RawValue>, Failure> {
        match (method, params.get("name").and_then(Value::as_str)) {
            ("status.get", Some("host.buttons")) => raw(&self.buttons.get().unwrap().value()),
            _ => self.page.call(window, method, params, reply),
        }
    }
}

fn start(config: &Path, owner: Arc<ButtonsOwner>) -> Endpoint {
    let endpoint = Endpoint::start(&config.join("sockets"), config, "test-buttons", owner).unwrap();
    endpoint.publish("main").unwrap();
    endpoint
}

fn request(connection: &mut Connection, id: u64, method: &str, params: Value) -> Value {
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
fn next_mask(connection: &mut Connection) -> Value {
    let got = endpoint::read_frame(connection)
        .unwrap()
        .expect("no host.buttons notification");
    assert_eq!(got["method"], "status.changed", "{got}");
    assert_eq!(got["params"]["window"], "main", "{got}");
    assert_eq!(got["params"]["name"], "host.buttons", "{got}");
    got["params"]["value"]["mask"].clone()
}

// contract: exposure.host-buttons.notifies-mask-change
#[test]
fn buttons_notify_each_mask_change() {
    let config = folder::Folder::new();
    // The page receives the watch of host.buttons, which it answers with null.
    let page = CasePage::new(
        &["main"],
        vec![exchange(
            "status.watch",
            json!({"name": "host.buttons"}),
            Value::Null,
        )],
    );
    let owner = Arc::new(ButtonsOwner {
        page: page.clone(),
        buttons: OnceLock::new(),
    });
    let endpoint = start(config.path(), owner.clone());
    let notifier = endpoint.notifier();
    let buttons = Arc::new(Buttons::new(move |value| {
        notifier.notify_watchers("host.buttons", &raw(&value).unwrap())
    }));
    assert!(owner.buttons.set(buttons.clone()).is_ok());
    let mut connection = endpoint_client::connect(endpoint.address());
    let watch = json!({"window": "main", "name": "host.buttons"});
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
    assert_eq!(page.finish(), Vec::<String>::new());
    endpoint.stop();
}

// contract: host.locks.poisoned-state-is-recovered
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
