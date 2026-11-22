//! The view send of an answered request (docs/spec/persistent-services.md#owned-session-messages).

use super::*;

/// The view send of an answered request: it is admitted like view_sidecar_send, and the returned wait ends with the reply
/// whose surface and correlation identifiers equal the request's (docs/spec/persistent-services.md#owned-session-messages).
pub fn view_sidecar_send_answered<O: crate::sidecars::Owner>(
    data: &crate::windows::WindowData,
    sidecars: &crate::sidecars::Sidecars<O>,
    owner: &O,
    request: ViewSidecarSendRequest,
) -> Result<crate::sidecars::AnswerWaiter, String> {
    request.check()?;
    // default: a send that waits for no reply carries no cids, so an absent cids member is an empty list.
    let cids = request.cids.clone().unwrap_or_default();
    sidecars.send_answered(&request.sidecar, &request.surface, &cids, || {
        let authority = view_authority(data, &request)?;
        sidecars.send_from_view(
            owner,
            &request.sidecar,
            &request.surface,
            &request.body,
            &cids,
            &authority,
        )
    })
}

#[cfg(test)]
#[path = "view_sidecar_answer_test.rs"]
mod view_sidecar_answer_test;
