//! host.buttons 의 값.
//!
//! 버튼 source(Platform::watch_buttons)가 보고한 눌린 마우스 버튼 mask 를 보관하고, mask 가 바뀌면 새 값을
//! 알린다. input.pointer 는 이 mask 가 0 이 아닌 동안 누름과 뗌을 1007 로 거부하므로, 거부된 뗌의 열린 누름은
//! 이 값이 0 이 된 뒤 끝낼 수 있다(docs/spec/exposure.md#host-entries).

use std::sync::Mutex;

use serde_json::{json, Value};

use crate::application_log::log_error;

pub struct Buttons {
    mask: Mutex<u64>,
    changed: Box<dyn Fn(Value) + Send + Sync>,
}

impl Buttons {
    /// mask 0 의 host.buttons 를 만든다. changed 는 바뀐 값마다 보고한 차례대로 한 번 호출된다.
    pub fn new(changed: impl Fn(Value) + Send + Sync + 'static) -> Self {
        Buttons {
            mask: Mutex::new(0),
            changed: Box::new(changed),
        }
    }

    /// source 가 읽은 mask 를 기록한다. 기록한 값과 다르면 새 값을 알린다. 알림의 순서가 보고의 순서와 같도록
    /// 잠금 안에서 알린다. changed 는 막히지 않아야 한다.
    pub fn report(&self, mask: u64) {
        let Ok(mut current) = self.mask.lock() else {
            log_error("host.buttons", "the button state is poisoned");
            return;
        };
        if *current == mask {
            return;
        }
        *current = mask;
        (self.changed)(value(mask));
    }

    /// host.buttons 의 현재 값 {mask} 다.
    pub fn value(&self) -> Value {
        match self.mask.lock() {
            Ok(mask) => value(*mask),
            Err(poisoned) => value(*poisoned.into_inner()),
        }
    }
}

fn value(mask: u64) -> Value {
    json!({ "mask": mask })
}
