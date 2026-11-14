//! Checks the agent sources (docs/spec/cli.md#agent-sources): sok embeds the files of packages/sok/go/src/agents with
//! `include_str!`, which the compiler reads from those files, and the bounds of the skill description and of the MCP instructions
//! count alike for every text.

// contract: cli.agents.embeds-the-sources
#[test]
fn the_embedded_agent_texts_pass_their_bounds() {
    assert_eq!(
        soksak_sok::agents::check_agent_sources(soksak_sok::agents::SKILL, soksak_sok::agents::MCP),
        Ok(())
    );
    // A non-ASCII text counts the description in Unicode scalar values and the instructions in bytes of UTF-8.
    let check = |description: &str, instructions: &str| {
        soksak_sok::agents::check_agent_sources(
            &format!("---\nname: soksak\ndescription: {description}\n---\nbody\n"),
            &serde_json::json!({"instructions": instructions, "tools": []}).to_string(),
        )
    };
    let korean = "가".repeat(1024);
    assert_eq!(check(&korean, &"가".repeat(1365)), Ok(()));
    assert_eq!(
        check(&format!("{korean}가"), "short"),
        Err("the skill description has 1025 Unicode scalar values, more than 1024".into())
    );
    assert_eq!(
        check("short", &"가".repeat(1366)),
        Err("the MCP instructions have 4098 bytes of UTF-8, more than 4096".into())
    );
    assert_eq!(
        soksak_sok::agents::check_agent_sources("no front matter\n", soksak_sok::agents::MCP),
        Err("the skill has no front matter".into())
    );
    assert_eq!(
        soksak_sok::agents::check_agent_sources(
            "---\nname: other\ndescription: d\n---\n",
            soksak_sok::agents::MCP
        ),
        Err("the skill front matter names other, not soksak".into())
    );
}
