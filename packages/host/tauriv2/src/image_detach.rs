use std::sync::PoisonError;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::sync_channel;
use std::time::{Duration, Instant};

use serde_json::Value;
use serde_json::value::RawValue;

use super::{ImageDetachWaiter, Owner, Sidecars};

struct PendingImageDetach {
    request: String,
    receiver: std::sync::mpsc::Receiver<Result<(), String>>,
    target: crate::images::DetachTarget,
}

const IMAGE_DETACH_TIMEOUT: Duration = Duration::from_secs(10);
const IMAGE_DETACH_LIMIT: usize = 1024;
/// One service can serve multiple windows, so request ids share one process-wide sequence.
static NEXT_IMAGE_DETACH_REQUEST: AtomicU64 = AtomicU64::new(1);

impl<O: Owner> Sidecars<O> {
    /// Sends every image detach before waiting for the exact acknowledgements under one deadline.
    pub(crate) fn detach_images(
        &self,
        owner: &O,
        targets: &[crate::images::DetachTarget],
    ) -> Result<(), String> {
        self.detach_images_until(owner, targets, IMAGE_DETACH_TIMEOUT)
    }

    fn detach_images_until(
        &self,
        owner: &O,
        targets: &[crate::images::DetachTarget],
        timeout: Duration,
    ) -> Result<(), String> {
        if targets.is_empty() {
            return Ok(());
        }
        let deadline = Instant::now() + timeout;
        let mut pending = Vec::with_capacity(targets.len());
        for target in targets {
            if target.surface.is_empty()
                || target.name.is_empty()
                || target.sidecar.is_empty()
                || target.generation == 0
            {
                self.cancel_image_detaches(&pending);
                return Err("image detach target is incomplete".to_string());
            }
            let serial = match NEXT_IMAGE_DETACH_REQUEST.fetch_update(
                Ordering::Relaxed,
                Ordering::Relaxed,
                |value| value.checked_add(1),
            ) {
                Ok(serial) => serial,
                Err(_) => {
                    self.cancel_image_detaches(&pending);
                    return Err("image detach request identifiers are exhausted".to_string());
                }
            };
            let request = format!("image-detach-{}-{serial}", std::process::id());
            let (sender, receiver) = sync_channel(1);
            {
                let mut waiters = self
                    .core
                    .image_detaches
                    .lock()
                    // default: a thread that stopped while holding the lock leaves each pending acknowledgement
                    // independently addressable; the panic hook records the stop.
                    .unwrap_or_else(PoisonError::into_inner);
                if waiters.len() >= IMAGE_DETACH_LIMIT {
                    drop(waiters);
                    self.cancel_image_detaches(&pending);
                    return Err(format!(
                        "image detach acknowledgements reached the limit of {IMAGE_DETACH_LIMIT}"
                    ));
                }
                waiters.insert(
                    request.clone(),
                    ImageDetachWaiter {
                        sidecar: target.sidecar.clone(),
                        surface: target.surface.clone(),
                        name: target.name.clone(),
                        generation: target.generation,
                        result: sender,
                    },
                );
            }
            pending.push(PendingImageDetach {
                request: request.clone(),
                receiver,
                target: target.clone(),
            });
            let body = serde_json::json!({"image":{"detach":{
                "request": request,
                "name": target.name,
                "generation": target.generation,
            }}});
            let body = match RawValue::from_string(body.to_string()) {
                Ok(body) => body,
                Err(error) => {
                    self.cancel_image_detaches(&pending);
                    return Err(format!("image detach serialization: {error}"));
                }
            };
            if let Err(error) = self.send(owner, &target.sidecar, &target.surface, &body) {
                self.cancel_image_detaches(&pending);
                return Err(format!(
                    "image detach {}/{} request {request}: {error}",
                    target.surface, target.name
                ));
            }
        }

        let mut failures = Vec::new();
        for request in &pending {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let result = if remaining.is_zero() {
                Err("timed out".to_string())
            } else {
                match request.receiver.recv_timeout(remaining) {
                    Ok(result) => result,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("timed out".to_string()),
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        Err("acknowledgement waiter ended".to_string())
                    }
                }
            };
            if let Err(error) = result {
                failures.push(format!(
                    "image detach {}/{} request {}: {error}",
                    request.target.surface, request.target.name, request.request
                ));
            }
        }
        self.cancel_image_detaches(&pending);
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn cancel_image_detaches(&self, pending: &[PendingImageDetach]) {
        for request in pending {
            self.cancel_image_detach(&request.request);
        }
    }

    fn cancel_image_detach(&self, request: &str) {
        self.core
            .image_detaches
            .lock()
            // default: cancellation removes only the exact opaque request, and a poisoned lock retains other requests.
            .unwrap_or_else(PoisonError::into_inner)
            .remove(request);
    }

    /// Validates and consumes one acknowledgement against its exact pending supplier request.
    pub(super) fn acknowledge_image_detach(
        &self,
        sidecar: &str,
        surface: &str,
        body: &RawValue,
    ) -> Result<(), String> {
        let value: Value = serde_json::from_str(body.get())
            .map_err(|error| format!("invalid image detach acknowledgement: {error}"))?;
        let ack = value
            .pointer("/image/detached")
            .and_then(Value::as_object)
            .ok_or_else(|| "image detach acknowledgement has no object payload".to_string())?;
        let request = ack
            .get("request")
            .and_then(Value::as_str)
            .filter(|request| !request.is_empty())
            .ok_or_else(|| "image detach acknowledgement has no request id".to_string())?;
        let name = ack
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| format!("image detach acknowledgement {request} has no image name"))?;
        let generation = ack
            .get("generation")
            .and_then(Value::as_u64)
            .filter(|generation| *generation > 0)
            .ok_or_else(|| {
                format!("image detach acknowledgement {request} has no valid generation")
            })?;
        let mut waiters = self
            .core
            .image_detaches
            .lock()
            // default: removing the matching waiter settles only the request named by the supplier; a poisoned lock
            // retains its other waiters and the panic hook records the stop.
            .unwrap_or_else(PoisonError::into_inner);
        let Some(waiter) = waiters.get(request) else {
            return Err(format!(
                "image detach acknowledgement {request} has no pending request"
            ));
        };
        let tuple_matches = waiter.sidecar == sidecar
            && waiter.surface == surface
            && waiter.name == name
            && waiter.generation == generation;
        if !tuple_matches {
            return Err(format!(
                "image detach acknowledgement {request} does not match its sidecar, surface, image, or generation"
            ));
        }
        let waiter = waiters.remove(request).ok_or_else(|| {
            format!("image detach acknowledgement {request} has no pending request")
        })?;
        drop(waiters);
        let result = match ack.get("ok").and_then(Value::as_bool) {
            Some(true) => match ack.get("result").and_then(Value::as_str) {
                Some("detached" | "alreadyDetached" | "alreadyAbsent") => Ok(()),
                Some(result) => Err(format!(
                    "image detach acknowledgement {request} has invalid result {result:?}"
                )),
                None => Err(format!(
                    "image detach acknowledgement {request} has no result"
                )),
            },
            Some(false) => match ack.get("error").and_then(Value::as_str) {
                Some(error) if !error.is_empty() => {
                    Err(format!("supplier rejected image detach {request}: {error}"))
                }
                _ => Err(format!(
                    "image detach acknowledgement {request} has no rejection reason"
                )),
            },
            _ => Err(format!(
                "image detach acknowledgement {request} has no boolean result"
            )),
        };
        waiter
            .result
            .send(result.clone())
            .map_err(|_| format!("image detach acknowledgement {request} has no waiting reload"))?;
        result
    }
}

#[cfg(test)]
#[path = "image_detach_test.rs"]
mod tests;
