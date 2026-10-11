//! The record of the endpoint methods (docs/spec/logging.md#entrances): every method that a client of the endpoint calls is
//! the event `host.endpoint.call`, whether or not the performance trace is on.

use std::time::Instant;

use serde::Deserialize;
use serde_json::json;
use serde_json::value::RawValue;

use crate::application_log::log_error;
use crate::bounds::{cut_text, CALL_TEXT_BYTES};
use crate::endpoint::Failure;
use crate::event_log::Level;
use crate::event_record::emit_host;
use crate::log_policy::Class;

/// The params of a request, as received.
#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    params: Option<&'a RawValue>,
}

/// One request being handled: its method, the arguments cut to the bound, and the time it started.
pub(crate) struct Call {
    method: String,
    args: String,
    truncated: bool,
    started: Instant,
}

impl Call {
    /// Starts the record of the request in `body` (the frame as received). The arguments are the text of `params` as
    /// received, `null` when the request has none, cut to `CALL_TEXT_BYTES` before they are copied.
    pub(crate) fn begin(method: &str, body: &[u8]) -> Call {
        let started = Instant::now();
        // The arguments are kept for the event of a success or of a failure; when the policy stores neither, they are not cut.
        if !crate::log_policy::event_enabled(Class::Call, Level::Debug)
            && !crate::log_policy::event_enabled(Class::Call, Level::Warn)
        {
            return Call {
                method: method.to_string(),
                args: String::new(),
                truncated: false,
                started,
            };
        }
        let (args, truncated) = match serde_json::from_slice::<Envelope>(body) {
            Ok(Envelope {
                params: Some(params),
            }) => cut_text(params.get(), CALL_TEXT_BYTES),
            Ok(Envelope { params: None }) => ("null".to_string(), false),
            Err(error) => {
                log_error(
                    "endpoint record",
                    format!("the params of {method} cannot be read: {error}"),
                );
                (String::new(), false)
            }
        };
        Call {
            method: method.to_string(),
            args,
            truncated,
            started,
        }
    }

    /// Stores the event with the result and the microseconds since the request began. A failed request is at the level
    /// `warn`, and its error text is the code and the message that the client receives.
    pub(crate) fn record<T>(self, outcome: &Result<T, Failure>) {
        // The gate is asked before the fields are built: a request that the policy does not store costs one branch.
        let level = if outcome.is_ok() {
            Level::Debug
        } else {
            Level::Warn
        };
        if !crate::log_policy::gate_event(Class::Call, level) {
            return;
        }
        let micros = self.started.elapsed().as_micros() as u64;
        match outcome {
            Ok(_) => emit_host(
                Level::Debug,
                "host.endpoint.call",
                json!({"name": self.method, "args": self.args, "micros": micros, "ok": true, "truncated": self.truncated}),
            ),
            Err(failure) => {
                let (error, cut) = cut_text(
                    &format!("{}: {}", failure.code, failure.message),
                    CALL_TEXT_BYTES,
                );
                emit_host(
                    Level::Warn,
                    "host.endpoint.call",
                    json!({"name": self.method, "args": self.args, "micros": micros, "ok": false, "truncated": self.truncated || cut, "error": error}),
                );
            }
        }
    }
}
