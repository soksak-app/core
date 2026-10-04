//! host.buttons 의 값과 그 알림 테스트. 엔드포인트의 창과 페이지는 가짜 서비스가 대신한다.

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Map, Value};
use soksak_host_tauriv2::buttons::Buttons;
use soksak_host_tauriv2::endpoint::{self, raw, Connection, Endpoint, Failure, Service};

/// 창 w1 만 가지고 host.buttons 를 buttons 의 값으로 답하는 서비스.
struct Fake {
    buttons: OnceLock<Arc<Buttons>>,
}

impl Service for Fake {
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

/// host.buttons 의 다음 알림의 mask.
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
    let config = tempfile::tempdir().unwrap();
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
    // 같은 mask 의 보고는 알리지 않는다. 다음 알림은 다음의 다른 mask 다.
    buttons.report(0);
    buttons.report(1);
    assert_eq!(next_mask(&mut connection), 1);
    buttons.report(1);
    buttons.report(3);
    buttons.report(0);
    assert_eq!(next_mask(&mut connection), 3);
    assert_eq!(next_mask(&mut connection), 0);
    // 남은 알림이 있으면 이 요청의 답보다 먼저 온다.
    assert_eq!(
        request(&mut connection, 3, "status.get", watch)["result"],
        json!({"mask": 0})
    );
    endpoint.stop();
}
