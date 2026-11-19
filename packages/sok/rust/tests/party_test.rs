use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

#[path = "support/folder.rs"]
mod folder;

#[path = "support/case_player.rs"]
mod case_player;

use case_player::play_case;

/// The directory of the paths.d slot that the path entry checks use. The party tests do not change it.
static PATHS: Mutex<PathBuf> = Mutex::new(PathBuf::new());

/// Runs sok with the arguments and returns its exit code, standard output and standard error.
fn run(args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let paths = PATHS.lock().expect("paths").clone();
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(&paths),
        core_version: "0.0.2",
        config_dir_variable: None,
        surface_variable: None,
    };
    let code = soksak_sok::run(&args, &mut stdout, &mut stderr, &options);
    (
        code,
        String::from_utf8(stdout).expect("stdout"),
        String::from_utf8(stderr).expect("stderr"),
    )
}

// contract: cli.describe.parties-first-and-card-party
#[test]
fn describe_lists_the_parties_first_and_each_card_party_and_leader() {
    let player = play_case("sok-describe-parties");
    let (code, stdout, stderr) = run(&["describe", "--config-dir", &player.dir()]);
    assert_eq!(code, 0, "{stderr}");
    let parties_at = stdout
        .find("\"parties\"")
        .expect("describe has a parties member");
    assert!(
        parties_at < stdout.find("\"window\"").expect("window member"),
        "parties come first: {stdout}"
    );
    let description: Value = serde_json::from_str(&stdout).expect("describe is JSON");
    let parties = description["parties"].as_array().expect("parties list");
    assert_eq!(parties.len(), 1);
    assert_eq!(parties[0]["id"], "p1");
    let cards = description["layout"]["root"]["children"]
        .as_array()
        .expect("cards");
    assert_eq!(cards.len(), 2);
    assert_eq!(cards[0]["party"], "p1");
    assert_eq!(cards[0]["leader"], true);
    assert_eq!(cards[1]["party"], "p1");
    assert_eq!(cards[1]["leader"], false);
}

// contract: cli.describe.summary-and-full
#[test]
fn describe_summary_holds_summary_statuses_and_full_holds_every_status() {
    let player = play_case("sok-describe-summary-and-full");
    let (_, summary, stderr) = run(&["describe", "--config-dir", &player.dir()]);
    assert!(
        summary.contains("\"probe.busy\""),
        "summary lacks the summary status: {stderr} {summary}"
    );
    assert!(
        !summary.contains("\"probe.detail\""),
        "summary holds a status that is not a summary: {summary}"
    );
    let (_, full, stderr) = run(&["describe", "--full", "--config-dir", &player.dir()]);
    assert!(
        full.contains("\"probe.detail\"") && full.contains("\"probe.busy\""),
        "full lacks the tab statuses: {stderr} {full}"
    );
}

// contract: cli.status.core-parties-every-field
#[test]
fn status_core_parties_returns_every_party_field() {
    let player = play_case("sok-status-parties");
    let (code, stdout, stderr) = run(&["status", "core.parties", "--config-dir", &player.dir()]);
    assert_eq!(code, 0, "{stderr}");
    let parties: Value = serde_json::from_str(&stdout).expect("a JSON list");
    let record = &parties.as_array().expect("list of parties")[0];
    for field in [
        "id",
        "cards",
        "leader",
        "color",
        "leaderColor",
        "outline",
        "reason",
    ] {
        assert!(
            record.get(field).is_some(),
            "party record lacks {field}: {record}"
        );
    }
}

// contract: cli.party.get-and-card-get
#[test]
fn party_get_and_card_get_answer_the_party_and_card_queries() {
    let player = play_case("sok-party-get-and-card-get");
    let (code, stdout, stderr) = run(&[
        "core.party.get",
        "--party",
        "p1",
        "--config-dir",
        &player.dir(),
    ]);
    assert_eq!(code, 0, "{stderr}");
    let party: Value = serde_json::from_str(&stdout).expect("party is JSON");
    assert!(
        party.get("members").is_some(),
        "core.party.get lacks members: {party}"
    );
    let (code, stdout, stderr) = run(&[
        "core.card.get",
        "--card",
        "b",
        "--config-dir",
        &player.dir(),
    ]);
    assert_eq!(code, 0, "{stderr}");
    let card: Value = serde_json::from_str(&stdout).expect("card is JSON");
    assert_eq!(card["party"], "p1");
    assert_eq!(card["leader"], false);
}

// contract: cli.commands.query-party
#[test]
fn commands_query_party_lists_the_party_commands_only() {
    let player = play_case("sok-commands-query-party");
    let (code, stdout, stderr) = run(&[
        "commands",
        "--query",
        "party",
        "--config-dir",
        &player.dir(),
    ]);
    assert_eq!(code, 0, "{stderr}");
    let commands: Value = serde_json::from_str(&stdout).expect("a JSON list");
    let names: Vec<&str> = commands
        .as_array()
        .expect("list")
        .iter()
        .map(|command| command["name"].as_str().expect("name"))
        .collect();
    for name in [
        "core.party.create",
        "core.party.update",
        "core.party.add",
        "core.party.remove",
        "core.party.delete",
        "core.party.get",
    ] {
        assert!(names.contains(&name), "query party lacks {name}: {names:?}");
    }
    assert!(
        !names.contains(&"core.card.close"),
        "query party lists a command that is not a party command"
    );
}

/// The endpoint case of describe holds the snapshot of the parties; a core.parties status without its value is refused with its name.
#[test]
fn a_core_parties_status_without_a_value_is_refused_with_its_name() {
    let case: Value = serde_json::from_str(include_str!(
        "../../../../docs/spec/cases/endpoint/sok-describe-parties.json"
    ))
    .expect("the case is JSON");
    let mut snapshot = case["variables"]["snapshot"]["example"].clone();
    for group in snapshot["groups"].as_array_mut().expect("groups") {
        if group["owner"] != "core" {
            continue;
        }
        for status in group["status"].as_array_mut().expect("status") {
            if status["name"] == "core.parties" {
                status.as_object_mut().expect("status object").remove("value");
            }
        }
    }
    let player = case_player::play_case_with_raw(
        "sok-describe-parties",
        "snapshot",
        &snapshot.to_string(),
    );
    let (code, _stdout, stderr) = run(&["describe", "--config-dir", &player.dir()]);
    assert_ne!(code, 0, "describe accepts a core.parties status without a value");
    assert!(
        stderr.contains("core.parties has no value"),
        "the error names the status: {stderr}"
    );
}
