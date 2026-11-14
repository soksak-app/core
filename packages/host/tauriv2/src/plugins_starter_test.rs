use serde_json::json;
use soksak_host::arguments::Argument;
use soksak_host::framework::InvokeBody;
use soksak_host::plugins::StarterRequest;

// contract: plugins.starter.rejects-invalid-request
#[test]
fn plugins_starter_rejects_an_invalid_request_through_the_registered_command() {
    assert!(super::command_names().contains(&"plugins_starter"));
    // The command takes its request as `Argument<StarterRequest>`, which decodes the body of the call with the decoder of the
    // host library.
    let arguments = json!({"request": {"state": 3}});
    let body = InvokeBody::Json(&arguments);
    let error = Argument::<StarterRequest>::from_body("plugins_starter", "request", &body)
        .err()
        .unwrap();
    assert_eq!(
        error,
        "argument request.state must be a string, not a number"
    );
}
