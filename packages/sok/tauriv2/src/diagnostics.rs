//! 진단 build 의 명령(docs/spec/cli.md). 일반 build 의 sok 에는 진단 method 가 없다.

use serde_json::Value;

use crate::{compact, Request};

/// capture 의 요청. 창을 앞으로 가져오지 않고 그 화면을 이미지 파일로 쓴다.
pub(crate) fn capture(window: String) -> Request {
    Request {
        method: "diagnostics.capture.still",
        params: Some(compact(vec![("window", Some(Value::String(window)))])),
        watch: false,
        field: None,
    }
}
