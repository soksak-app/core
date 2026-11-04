use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;

use super::{ImageDetachWaiter, Owner, Sidecars};
use crate::application_log::log_error;
use crate::images::{DetachTarget, Images};

/// The deadline after which an unacknowledged detach writes its error; the wait continues after it.
pub(crate) const IMAGE_DETACH_TIMEOUT: Duration = Duration::from_secs(10);
/// One service can serve multiple windows, so request ids share one process-wide sequence.
static NEXT_IMAGE_DETACH_REQUEST: AtomicU64 = AtomicU64::new(1);

/// The end of one image detach request.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DetachOutcome {
    /// The supplier released the image.
    Detached,
    /// The supplier refused the detach with this reason.
    Rejected(String),
    /// The supplier connection or the host ended before an acknowledgement.
    SupplierEnded,
    /// The surface session ended with its tab before an acknowledgement.
    SessionEnded,
}

/// The wait of one detach that `begin_image_detaches` started. `timed_out` disconnects when the deadline error is
/// recorded, or when the wait ends without it, and `thread` ends when the wait ends; they are the interface through
/// which a check observes the wait.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "only a check observes the wait of a detach")
)]
pub(crate) struct DetachWait {
    pub timed_out: Receiver<()>,
    pub thread: JoinHandle<()>,
}

/// Sends an image-detach-ended event `{surface, error}` to the page of the window.
pub type EndedEvent = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

/// Names the target of a detach in its errors.
pub(crate) fn detach_target_text(target: &DetachTarget) -> String {
    format!(
        "image detach sidecar {} surface {} image {} generation {}",
        target.sidecar, target.surface, target.name, target.generation
    )
}

#[derive(Deserialize)]
struct DetachAcknowledgement<'a> {
    #[serde(borrow)]
    image: Option<DetachAcknowledgementImage<'a>>,
}

#[derive(Deserialize)]
struct DetachAcknowledgementImage<'a> {
    #[serde(borrow, default, deserialize_with = "raw_value_present")]
    detached: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct DetachAcknowledgementFields<'a> {
    #[serde(borrow, default, deserialize_with = "raw_value_present")]
    request: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "raw_value_present")]
    name: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "raw_value_present")]
    generation: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "raw_value_present")]
    ok: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "raw_value_present")]
    result: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "raw_value_present")]
    error: Option<&'a RawValue>,
    #[serde(
        borrow,
        default,
        deserialize_with = "raw_value_present",
        rename = "currentGeneration"
    )]
    current_generation: Option<&'a RawValue>,
}

fn raw_value_present<'de, D>(deserializer: D) -> Result<Option<&'de RawValue>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    <&RawValue>::deserialize(deserializer).map(Some)
}

/// Reads only the declared acknowledgement path and skips unrelated JSON members without materializing them.
pub(super) fn detach_acknowledgement_body(
    body: &RawValue,
) -> Result<Option<&RawValue>, serde_json::Error> {
    let envelope: DetachAcknowledgement<'_> = serde_json::from_str(body.get())?;
    Ok(envelope.image.and_then(|image| image.detached))
}

/// Ends the pending detaches whose waiter matches accepts because the supplier connection, the surface session or the
/// host ended. The caller holds the sidecar state lock; each result channel has one free slot, so the delivery does not
/// block.
pub(super) fn release_image_detaches(
    waiters: &mut HashMap<String, ImageDetachWaiter>,
    session: bool,
    matches: impl Fn(&ImageDetachWaiter) -> bool,
) {
    let outcome = || {
        if session {
            DetachOutcome::SessionEnded
        } else {
            DetachOutcome::SupplierEnded
        }
    };
    waiters.retain(|request, waiter| {
        if !matches(waiter) {
            return true;
        }
        if let Err(TrySendError::Disconnected(_) | TrySendError::Full(_)) =
            waiter.result.try_send(outcome())
        {
            log_error(
                "image detach",
                format!("image detach request {request} has no wait to release"),
            );
        }
        false
    });
}

/// Sends the detach of each target and returns without waiting. A thread waits for each acknowledgement, and the
/// surface of the target stays pending in images until its detach ends (docs/spec/sidecars.md). ended_event sends the
/// image-detach-ended event of a surface whose last pending detach ended while the page is ready for it.
pub(crate) fn begin_image_detaches<O: Owner>(
    sidecars: &Sidecars<O>,
    owner: &O,
    images: &Images,
    targets: Vec<DetachTarget>,
    timeout: Duration,
    ended_event: EndedEvent,
) -> Result<Vec<DetachWait>, String> {
    let mut waits = Vec::with_capacity(targets.len());
    for target in targets {
        let (request, result) = sidecars.begin_image_detach(owner, &target)?;
        images.add_pending_detach(&target, &request);
        let (timed_out_sender, timed_out) = sync_channel(1);
        let images = images.clone();
        let ended_event = Arc::clone(&ended_event);
        let thread = std::thread::Builder::new()
            .name("image-detach-wait".to_string())
            .spawn(move || {
                wait_image_detach(
                    &images,
                    &target,
                    &request,
                    &result,
                    timeout,
                    timed_out_sender,
                    &*ended_event,
                )
            })
            .map_err(|error| format!("image detach wait thread: {error}"))?;
        waits.push(DetachWait { timed_out, thread });
    }
    Ok(waits)
}

/// Waits for the end of one pending detach. The deadline is a timer because a supplier that does not answer sends no
/// event; it records that failure and does not end the wait.
fn wait_image_detach(
    images: &Images,
    target: &DetachTarget,
    request: &str,
    result: &Receiver<DetachOutcome>,
    timeout: Duration,
    timed_out: SyncSender<()>,
    ended_event: &dyn Fn(serde_json::Value),
) {
    let text = detach_target_text(target);
    let outcome = match result.recv_timeout(timeout) {
        Ok(outcome) => Ok(outcome),
        Err(RecvTimeoutError::Timeout) => {
            log_error(
                "image detach",
                format!("{text} request {request} timed out"),
            );
            drop(timed_out);
            result.recv().map_err(|_| ())
        }
        Err(RecvTimeoutError::Disconnected) => Err(()),
    };
    let (failure, session) = match outcome {
        Ok(DetachOutcome::Detached) => (None, false),
        Ok(DetachOutcome::Rejected(reason)) => (
            Some(format!("{text} request {request} rejected: {reason}")),
            false,
        ),
        Ok(DetachOutcome::SupplierEnded) => (
            Some(format!(
                "{text} request {request} ended: the supplier connection ended"
            )),
            false,
        ),
        // The tab of the surface is gone, so its end is told to no page.
        Ok(DetachOutcome::SessionEnded) => (None, true),
        Err(()) => (
            Some(format!("{text} request {request} ended without an outcome")),
            false,
        ),
    };
    if let Some(event) = images.end_pending_detach(target, request, failure, session) {
        ended_event(event);
    }
}

impl<O: Owner> Sidecars<O> {
    /// Registers the waiter of one detach request and sends the request to its supplier.
    fn begin_image_detach(
        &self,
        owner: &O,
        target: &DetachTarget,
    ) -> Result<(String, Receiver<DetachOutcome>), String> {
        let text = detach_target_text(target);
        if target.surface.is_empty()
            || target.name.is_empty()
            || target.sidecar.is_empty()
            || target.generation == 0
        {
            return Err(format!("{text} has an incomplete target"));
        }
        let serial = NEXT_IMAGE_DETACH_REQUEST
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| format!("{text}: image detach request identifiers are exhausted"))?;
        let request = format!("image-detach-{}-{serial}", std::process::id());
        let (sender, receiver) = sync_channel(1);
        self.core
            .state
            .lock()
            // default: a thread that stopped while holding the lock leaves each pending acknowledgement
            // independently addressable; the panic hook records the stop.
            .unwrap_or_else(PoisonError::into_inner)
            .image_detaches
            .insert(
                request.clone(),
                ImageDetachWaiter {
                    sidecar: target.sidecar.clone(),
                    surface: target.surface.clone(),
                    name: target.name.clone(),
                    generation: target.generation,
                    result: sender,
                },
            );
        let sent = serde_json::to_string(&serde_json::json!({"image":{"detach":{
            "request": request,
            "name": target.name,
            "generation": target.generation,
        }}}))
        .map_err(|error| error.to_string())
        .and_then(|body| RawValue::from_string(body).map_err(|error| error.to_string()))
        .and_then(|body| self.send(owner, &target.sidecar, &target.surface, &body));
        if let Err(error) = sent {
            self.core
                .state
                .lock()
                // default: removing the exact request leaves the other waiters of a poisoned lock in place; the panic
                // hook records the stop.
                .unwrap_or_else(PoisonError::into_inner)
                .image_detaches
                .remove(&request);
            return Err(format!("{text} request {request}: {error}"));
        }
        Ok((request, receiver))
    }

    /// Validates and consumes one acknowledgement against its exact pending supplier request.
    pub(super) fn acknowledge_image_detach(
        &self,
        sidecar: &str,
        surface: &str,
        body: &RawValue,
    ) -> Result<(), String> {
        let detached = detach_acknowledgement_body(body)
            .map_err(|error| format!("invalid image detach acknowledgement: {error}"))?
            .ok_or_else(|| "image detach acknowledgement has no object payload".to_string())?;
        // A payload that is not an object has no member to name, so its error names the payload.
        let ack: DetachAcknowledgementFields<'_> = serde_json::from_str(detached.get())
            .map_err(|_| "image detach acknowledgement has no object payload".to_string())?;
        let request = ack
            .request
            // default: malformed, missing, and empty request ids share the explicit no-request-id protocol error below.
            .and_then(|value| serde_json::from_str::<String>(value.get()).ok())
            .filter(|request| !request.is_empty())
            .ok_or_else(|| "image detach acknowledgement has no request id".to_string())?;
        let name = ack
            .name
            // default: malformed, missing, and empty names share the explicit no-image-name protocol error below.
            .and_then(|value| serde_json::from_str::<String>(value.get()).ok())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| format!("image detach acknowledgement {request} has no image name"))?;
        let generation = ack
            .generation
            // default: malformed, missing, zero, and out-of-range generations share the explicit invalid-generation error below.
            .and_then(|value| serde_json::from_str::<u64>(value.get()).ok())
            .filter(|generation| *generation > 0)
            .ok_or_else(|| {
                format!("image detach acknowledgement {request} has no valid generation")
            })?;
        let ok = ack
            .ok
            // default: a missing or non-boolean status becomes the explicit no-boolean-result error below.
            .and_then(|value| serde_json::from_str::<bool>(value.get()).ok())
            .ok_or_else(|| {
                format!("image detach acknowledgement {request} has no boolean result")
            })?;
        // An absent member is empty, which the checks below reject where the member is required.
        let text = |member: &str, value: Option<&RawValue>| match value {
            None => Ok(String::new()),
            Some(value) => serde_json::from_str::<String>(value.get()).map_err(|_| {
                format!("image detach acknowledgement {request} has no string {member}")
            }),
        };
        let (result, error) = (text("result", ack.result)?, text("error", ack.error)?);
        let outcome = if ok {
            if !error.is_empty()
                || !matches!(
                    result.as_str(),
                    "detached" | "alreadyDetached" | "alreadyAbsent"
                )
            {
                return Err(format!(
                    "invalid successful image detach acknowledgement {request:?} for surface {surface}"
                ));
            }
            DetachOutcome::Detached
        } else {
            if error.is_empty() {
                return Err(format!(
                    "failed image detach acknowledgement {request:?} has no error for surface {surface}"
                ));
            }
            match ack.current_generation {
                Some(value) => {
                    let current = serde_json::from_str::<u64>(value.get()).map_err(|_| {
                        format!(
                            "image detach acknowledgement {request} has no valid current generation"
                        )
                    })?;
                    DetachOutcome::Rejected(format!("{error} (current generation {current})"))
                }
                None => DetachOutcome::Rejected(error),
            }
        };
        let mut state = self
            .core
            .state
            .lock()
            // default: removing the matching waiter settles only the request named by the supplier; a poisoned lock
            // retains its other waiters and the panic hook records the stop.
            .unwrap_or_else(PoisonError::into_inner);
        let Some(waiter) = state.image_detaches.get(&request) else {
            return Err(format!(
                "image detach acknowledgement has no pending request {request:?} for surface {surface}"
            ));
        };
        if waiter.sidecar != sidecar
            || waiter.surface != surface
            || waiter.name != name
            || waiter.generation != generation
        {
            return Err(format!(
                "image detach acknowledgement {request:?} does not match its owner, surface, name, or generation"
            ));
        }
        let Some(waiter) = state.image_detaches.remove(&request) else {
            return Err(format!(
                "image detach acknowledgement has no pending request {request:?} for surface {surface}"
            ));
        };
        drop(state);
        waiter
            .result
            .try_send(outcome)
            .map_err(|_| format!("image detach acknowledgement {request:?} has no wait to end"))
    }
}

#[cfg(test)]
#[path = "image_detach_test.rs"]
mod tests;
