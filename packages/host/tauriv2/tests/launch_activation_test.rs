//! Checks the launch activation of the application (docs/spec/hosts.md#launch-activation).

use soksak_host_tauriv2::launch_activates_ignoring_other_apps;

// contract: application.launch.system-decides-activation
#[test]
fn the_application_leaves_the_launch_activation_to_the_system() {
    assert!(
        !launch_activates_ignoring_other_apps(),
        "the application activates itself when it finishes launching, so a launch that requested no activation takes the focus"
    );
}
