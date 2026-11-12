//! The dialogs of a window that an endpoint client answers: while a client watches host.dialog, the save panel and the folder
//! panel of the host are held as requests and answered by the client; the end of the watch cancels them; an answer passes the
//! checks of the panel of a person. The same cases run in the Go host.
use super::*;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

/// What a test sees: a change of host.dialog, or the return of a call that asked for a dialog.
#[derive(Debug)]
enum Seen {
    Changed(Value),
    Returned(Result<Option<Vec<String>>, String>),
}

/// Dialogs whose changes of the window w1 arrive on the channel of the test.
fn dialogs() -> (Arc<Dialogs>, Sender<Seen>, Receiver<Seen>) {
    let (send, seen) = channel();
    let changes = Mutex::new(send.clone());
    let dialogs = Arc::new(Dialogs::new(move |window: &str, value: Value| {
        assert_eq!(window, "w1", "host.dialog of another window changed");
        // default: a lock that a panicking thread poisoned still holds the sender of the test, which only sends.
        changes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .send(Seen::Changed(value))
            .expect("the test receives the changes of host.dialog");
    }));
    (dialogs, send, seen)
}

/// Asks for request in w1 on a thread of its own; the person's panel answers person and counts its calls.
fn ask(
    dialogs: &Arc<Dialogs>,
    send: &Sender<Seen>,
    request: Request,
    panels: &Arc<Mutex<u32>>,
    person: &str,
) {
    let (dialogs, send, panels, person) = (
        dialogs.clone(),
        send.clone(),
        panels.clone(),
        person.to_string(),
    );
    std::thread::spawn(move || {
        let answered = dialogs.ask("w1", request, || {
            *panels.lock().unwrap() += 1;
            Ok(Some(vec![person]))
        });
        send.send(Seen::Returned(answered))
            .expect("the test receives the return of the call");
    });
}

/// The value of host.dialog that the request of a call announced. A call that returns first was not held: its panel
/// answered, and the test fails at once.
fn held(seen: &Receiver<Seen>) -> Vec<Request> {
    match seen.recv().unwrap() {
        Seen::Changed(value) => pending(&value),
        Seen::Returned(answered) => panic!("the call returned {answered:?} without a held request"),
    }
}

/// The change of host.dialog that a call announced before it returned. A change that is not there was never announced, and
/// the test fails at once.
fn announced(seen: &Receiver<Seen>) -> Vec<Request> {
    match seen.try_recv() {
        Ok(Seen::Changed(value)) => pending(&value),
        other => panic!("the change of host.dialog was not announced: {other:?}"),
    }
}

/// The return of a call that asked.
fn returned(seen: &Receiver<Seen>) -> Result<Option<Vec<String>>, String> {
    match seen.recv().unwrap() {
        Seen::Returned(answered) => answered,
        Seen::Changed(value) => panic!("host.dialog changed to {value} before the call returned"),
    }
}

fn pending(value: &Value) -> Vec<Request> {
    serde_json::from_value(value["pending"].clone())
        .unwrap_or_else(|error| panic!("host.dialog {value} has no pending list: {error}"))
}

fn request(kind: &str) -> Request {
    Request {
        id: String::new(),
        kind: kind.into(),
        suggested_name: None,
        directory: None,
        multiple: false,
        directories: false,
        url: None,
    }
}

/// The paths as an answer names them.
fn names<P: AsRef<std::path::Path>>(paths: &[P]) -> Vec<String> {
    paths
        .iter()
        .map(|path| path.as_ref().display().to_string())
        .collect()
}

fn answer<P: AsRef<std::path::Path>>(paths: &[P]) -> Answer {
    Answer {
        id: String::new(),
        paths: names(paths),
        cancel: false,
        replace: false,
    }
}

// contract: dialog.host.held
#[test]
fn a_watched_window_holds_the_save_and_folder_panels_of_the_host() {
    let (dialogs, send, seen) = dialogs();
    let panels = Arc::new(Mutex::new(0));
    let root = crate::test_folder::Folder::new();
    let folder = root.canonicalize().unwrap();
    let mut save = request(SAVE);
    save.suggested_name = Some("host.jsonl".into());
    save.directory = Some(folder.display().to_string());

    ask(&dialogs, &send, save.clone(), &panels, "/person/host.jsonl");
    assert_eq!(
        returned(&seen),
        Ok(Some(vec!["/person/host.jsonl".to_string()]))
    );
    dialogs.watched("w1", true);

    ask(&dialogs, &send, save.clone(), &panels, "/person/host.jsonl");
    let waiting = held(&seen);
    assert_eq!(waiting.len(), 1, "the held save is {waiting:?}");
    assert!(!waiting[0].id.is_empty());
    assert_eq!(waiting[0].kind, SAVE);
    assert_eq!(waiting[0].suggested_name.as_deref(), Some("host.jsonl"));
    assert_eq!(waiting[0].directory, save.directory);
    assert_eq!(pending(&dialogs.value("w1")), waiting);
    let target = folder.join("saved.jsonl");
    let mut chosen = answer(&[&target]);
    chosen.id = waiting[0].id.clone();
    dialogs.answer("w1", chosen).unwrap();
    assert_eq!(announced(&seen), Vec::new());
    assert_eq!(
        returned(&seen),
        Ok(Some(vec![target.display().to_string()]))
    );

    ask(&dialogs, &send, request(FOLDER), &panels, "/person");
    let waiting = held(&seen);
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].kind, FOLDER);
    let cancel = Answer {
        id: waiting[0].id.clone(),
        paths: Vec::new(),
        cancel: true,
        replace: false,
    };
    dialogs.answer("w1", cancel.clone()).unwrap();
    assert_eq!(announced(&seen), Vec::new());
    assert_eq!(returned(&seen), Ok(None));
    assert_eq!(
        *panels.lock().unwrap(),
        1,
        "a watched window showed a panel"
    );
    let refused = dialogs.answer("w1", cancel).unwrap_err();
    assert!(refused.contains(&waiting[0].id), "{refused}");
}

// contract: dialog.watch.end-cancels
#[test]
fn the_end_of_the_watch_cancels_the_held_dialogs() {
    let (dialogs, send, seen) = dialogs();
    let panels = Arc::new(Mutex::new(0));
    dialogs.watched("w1", true);
    ask(
        &dialogs,
        &send,
        request(SAVE),
        &panels,
        "/person/host.jsonl",
    );
    held(&seen);
    dialogs.watched("w1", false);
    assert_eq!(announced(&seen), Vec::new());
    assert_eq!(returned(&seen), Ok(None));
    ask(
        &dialogs,
        &send,
        request(SAVE),
        &panels,
        "/person/host.jsonl",
    );
    assert_eq!(
        returned(&seen),
        Ok(Some(vec!["/person/host.jsonl".to_string()]))
    );
    assert_eq!(*panels.lock().unwrap(), 1);
}

// contract: dialog.answer.rules
#[test]
fn an_answer_passes_the_checks_of_the_panel() {
    let root = crate::test_folder::Folder::new();
    let folder = root.canonicalize().unwrap();
    let existing = folder.join("existing");
    std::fs::write(&existing, "kept").unwrap();
    let inner = folder.join("inner");
    std::fs::create_dir(&inner).unwrap();
    let missing = folder.join("missing");
    let fresh = folder.join("new");
    let with = |kind: &str, multiple: bool, directories: bool| Request {
        multiple,
        directories,
        ..request(kind)
    };
    let replace = |mut answer: Answer| {
        answer.replace = true;
        answer
    };
    let none: &[&std::path::Path] = &[];
    let cases: Vec<(Request, Answer, Result<Vec<String>, &str>)> = vec![
        (request(SAVE), answer(&[&fresh]), Ok(names(&[&fresh]))),
        (
            request(SAVE),
            replace(answer(&[&existing])),
            Ok(names(&[&existing])),
        ),
        (request(SAVE), answer(&[&existing]), Err("exists")),
        (
            request(SAVE),
            replace(answer(&[&inner])),
            Err("is a folder"),
        ),
        (
            request(SAVE),
            answer(&[std::path::Path::new("relative")]),
            Err("is not absolute"),
        ),
        (
            request(SAVE),
            answer(&[&folder.join("a:b")]),
            Err("holds ':'"),
        ),
        (
            request(SAVE),
            answer(&[&folder.join(".hidden")]),
            Err("starts with '.'"),
        ),
        (
            request(SAVE),
            answer(&[&missing.join("new")]),
            Err("does not exist"),
        ),
        (
            request(SAVE),
            answer(&[&existing.join("new")]),
            Err("is not a folder"),
        ),
        (
            request(SAVE),
            answer(&[&fresh, &existing]),
            Err("takes one path"),
        ),
        (request(SAVE), answer(none), Err("takes one path")),
        (request(DOWNLOAD), answer(&[&existing]), Err("exists")),
        (request(DOWNLOAD), answer(&[&fresh]), Ok(names(&[&fresh]))),
        (request(FOLDER), answer(&[&inner]), Ok(names(&[&inner]))),
        (
            request(FOLDER),
            answer(&[&existing]),
            Err("is not a folder"),
        ),
        (request(FOLDER), answer(&[&missing]), Err("does not exist")),
        (request(OPEN), answer(&[&existing]), Ok(names(&[&existing]))),
        (
            request(OPEN),
            answer(&[&existing, &existing]),
            Err("takes one path"),
        ),
        (
            with(OPEN, true, false),
            answer(&[&existing, &existing]),
            Ok(names(&[&existing, &existing])),
        ),
        (request(OPEN), answer(&[&inner]), Err("takes files")),
        (
            with(OPEN, false, true),
            answer(&[&inner]),
            Ok(names(&[&inner])),
        ),
        (request(OPEN), answer(&[&missing]), Err("does not exist")),
        (
            with(OPEN, true, false),
            answer(none),
            Err("takes at least one path"),
        ),
    ];
    for (asked, given, want) in cases {
        let got = choice(&asked, &given);
        match want {
            Ok(paths) => assert_eq!(got, Ok(paths), "{} {given:?}", asked.kind),
            Err(rule) => {
                let refusal = got.expect_err(&format!("{} {given:?} was taken", asked.kind));
                assert!(refusal.contains(rule), "{refusal} states no {rule}");
                if given.paths.len() == 1 {
                    assert!(refusal.contains(&given.paths[0]), "{refusal} names no path");
                }
            }
        }
    }

    let (dialogs, send, seen) = dialogs();
    let panels = Arc::new(Mutex::new(0));
    dialogs.watched("w1", true);
    ask(
        &dialogs,
        &send,
        request(SAVE),
        &panels,
        "/person/host.jsonl",
    );
    let waiting = held(&seen);
    let mut taken = answer(&[&existing]);
    taken.id = waiting[0].id.clone();
    assert!(
        dialogs.answer("w1", taken).is_err(),
        "a held save took an existing file without replace"
    );
    assert_eq!(pending(&dialogs.value("w1")), waiting);
    dialogs.watched("w1", false);
    assert_eq!(announced(&seen), Vec::new());
    assert_eq!(returned(&seen), Ok(None));
}
