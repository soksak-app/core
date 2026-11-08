//! Input source request validation and the role passed to the platform at the diagnostic endpoint boundary.
use super::{InputSourceChange, answer_input_source, parse_input_source};
use serde_json::{Value, json};
use std::cell::RefCell;

fn parse(params: Value) -> Result<Option<InputSourceChange>, String> {
    parse_input_source(params.as_object().unwrap()).map_err(|failure| failure.message)
}

// contract: diagnostics.input-source.selects-a-role
#[test]
fn input_source_refuses_a_string_that_is_not_a_role() {
    for params in [
        json!({"select": "source-latin"}),
        json!({"select": "greek"}),
        json!({"select": ""}),
        json!({"select": 3}),
    ] {
        assert_eq!(
            parse(params.clone()),
            Err("select must be one of latin, korean, japanese".into()),
            "{params}"
        );
    }
    assert_eq!(
        parse(json!({"select": "latin", "restore": "source-latin"})),
        Err("select and restore exclude each other".into())
    );
    assert_eq!(
        parse(json!({"restore": ""})),
        Err("restore must be a non-empty string".into())
    );
}

// contract: diagnostics.input-source.selects-a-role
#[test]
fn input_source_selects_the_role_through_the_platform() {
    // A platform whose input source of a role is `source-<role>` and whose person's input source has no role.
    let current = RefCell::new("person-source".to_string());
    let calls = RefCell::new(Vec::<String>::new());
    let answer = |change: Option<InputSourceChange>| {
        answer_input_source(
            change,
            |change| {
                match change {
                    InputSourceChange::Select(role) => {
                        calls.borrow_mut().push(format!("select {role}"));
                        *current.borrow_mut() = format!("source-{role}");
                    }
                    InputSourceChange::Restore(source) => {
                        calls.borrow_mut().push(format!("restore {source}"));
                        *current.borrow_mut() = source;
                    }
                }
                Ok(())
            },
            || {
                let source = current.borrow().clone();
                let role = source.strip_prefix("source-").map(str::to_string);
                Ok((role, source))
            },
        )
        .map_err(|failure| failure.message)
    };
    assert_eq!(
        answer(parse(json!({"window": "main"})).unwrap()),
        Ok(json!({"current": null, "source": "person-source"}))
    );
    for role in ["latin", "korean", "japanese"] {
        let change = parse(json!({"window": "main", "select": role})).unwrap();
        assert_eq!(change, Some(InputSourceChange::Select(role.into())));
        assert_eq!(
            answer(change),
            Ok(json!({"current": role, "source": format!("source-{role}")}))
        );
    }
    assert_eq!(
        answer(parse(json!({"restore": "person-source"})).unwrap()),
        Ok(json!({"current": null, "source": "person-source"}))
    );
    assert_eq!(
        *calls.borrow(),
        [
            "select latin",
            "select korean",
            "select japanese",
            "restore person-source"
        ]
    );
}
