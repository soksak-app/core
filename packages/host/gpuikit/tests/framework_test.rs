//! Tests of the identity of the GPUI framework adapter.

use soksak_host::framework::Framework as _;
use soksak_host_gpuikit::Framework;

#[test]
fn the_adapter_names_the_gpuikit_host() {
    let framework = Framework;
    assert_eq!(framework.application_name(), "gpuikit");
    assert_eq!(framework.display_name(), "GPUI");
}
