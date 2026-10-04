//! host 호출 인자의 해석을 검사한다(docs/spec/native-host.md#host-calls). 두 host 는 같은 인자를 같은 문장으로
//! 거부한다.

use serde::Deserialize;
use serde_json::{json, Value};
use soksak_host_tauriv2::arguments::decode;
use soksak_host_tauriv2::surfaces::SyncRequest;
use soksak_host_tauriv2::{documents, exposure, images, workspace};

fn refusal<T: serde::de::DeserializeOwned>(name: &str, value: Value) -> String {
    match decode::<T>(name, &value) {
        Ok(_) => panic!("argument {name} {value} was accepted"),
        Err(error) => error,
    }
}

/// 고정 길이 배열을 가진 인자.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct Shape {
    fill: [f64; 4],
}

// contract: host-calls.decode.messages
#[test]
fn arguments_are_refused_with_the_shared_messages() {
    let surface = json!({"id": "tab-1", "x": 0, "y": 0, "w": 1, "h": null, "visible": true, "dim": false,
        "composition": {"kind": "web"}});
    assert_eq!(
        refusal::<SyncRequest>("request", json!({"settled": true})),
        "argument request.surfaces is missing"
    );
    assert_eq!(
        refusal::<SyncRequest>("request", json!({"settled": true, "surfaces": []})),
        "argument request.titlebar is missing"
    );
    assert_eq!(
        refusal::<SyncRequest>("request", json!({"settled": true, "surfaces": [surface]})),
        "argument request.surfaces[0].h is missing"
    );
    assert_eq!(
        refusal::<SyncRequest>(
            "request",
            json!({"settled": true, "surfaces": [], "overlays": [{"x": "1", "y": 0, "w": 1, "h": 1}]})
        ),
        "argument request.overlays[0].x must be a number, not a string"
    );
    assert_eq!(
        refusal::<documents::Request>("request", Value::Null),
        "argument request must be an object, not null"
    );
    for offset in [json!(1.5), json!(2147483648_i64)] {
        assert_eq!(
            refusal::<documents::Request>(
                "request",
                json!({"surface": "s", "document": "d", "action": "entry", "offset": offset})
            ),
            "argument request.offset must be an integer from -2147483648 to 2147483647"
        );
    }
    assert_eq!(
        refusal::<images::Request>("request", json!({"surface": 5, "name": "view"})),
        "argument request.surface must be a string, not a number"
    );
    assert_eq!(
        refusal::<workspace::Request>("request", json!({"kind": "add", "project": 5})),
        "argument request.project must be an object, not a number"
    );
    assert_eq!(
        refusal::<String>("id", json!(5)),
        "argument id must be a string, not a number"
    );
    assert_eq!(
        refusal::<Shape>("request", json!({"fill": [0, 0, 0]})),
        "argument request.fill must be an array of 4 items"
    );
    // 선택 field 는 빠지거나 null 일 수 있다.
    decode::<documents::Request>(
        "request",
        &json!({"surface": "s", "document": "d", "url": null}),
    )
    .expect("optional fields may be missing or null");
    // 값이 없는 상태 변경은 값이 null 인 변경이다. Tauri runtime adapter 는 값을 JSON 텍스트로 보내고, 값이
    // undefined 이면 field 를 보내지 않는다.
    decode::<exposure::Changed>("request", &json!({"name": "core.grid"}))
        .expect("a status change may lack its value");
}
