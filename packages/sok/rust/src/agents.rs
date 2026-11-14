//! The texts that an agent reads, in one copy for both implementations (docs/spec/cli.md#agent-sources).

/// The agent skill (docs/spec/cli.md#agent-skill).
pub const SKILL: &str = include_str!("../../go/src/agents/SKILL.md");

/// `{instructions, tools}` of the MCP server (docs/spec/cli.md#mcp-server).
pub const MCP: &str = include_str!("../../go/src/agents/mcp.json");

/// The name of the skill, which equals the name of its folder.
const SKILL_NAME: &str = "soksak";

/// The bounds of the agent sources: an agent keeps the description of a skill and the instructions of a server in its context.
const SKILL_DESCRIPTION_VALUES: usize = 1024;
const MCP_INSTRUCTIONS_BYTES: usize = 4096;

/// Checks the skill and the MCP sources: the front matter names the skill soksak with a description of at most 1024 Unicode
/// scalar values, and the instructions have at most 4096 bytes of UTF-8.
pub fn check_agent_sources(skill: &str, mcp: &str) -> Result<(), String> {
    let matter = skill
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n"))
        .map(|(matter, _)| matter)
        .ok_or("the skill has no front matter")?;
    #[derive(serde::Deserialize)]
    struct Front {
        #[serde(default)]
        name: String,
        #[serde(default)]
        description: String,
    }
    let front: Front = serde_yaml_ng::from_str(matter)
        .map_err(|error| format!("the skill front matter: {error}"))?;
    if front.name != SKILL_NAME {
        return Err(format!(
            "the skill front matter names {}, not {SKILL_NAME}",
            front.name
        ));
    }
    let count = front.description.chars().count();
    if count > SKILL_DESCRIPTION_VALUES {
        return Err(format!(
            "the skill description has {count} Unicode scalar values, more than {SKILL_DESCRIPTION_VALUES}"
        ));
    }
    #[derive(serde::Deserialize)]
    struct Server {
        instructions: String,
    }
    let server: Server = serde_json::from_str(mcp)
        .map_err(|error| format!("the MCP sources have no instructions: {error}"))?;
    let size = server.instructions.len();
    if size > MCP_INSTRUCTIONS_BYTES {
        return Err(format!(
            "the MCP instructions have {size} bytes of UTF-8, more than {MCP_INSTRUCTIONS_BYTES}"
        ));
    }
    Ok(())
}
