# Messaging

[한국어](messaging.ko.md)

This document defines the messaging contract between terminals and agents. Implementation and verification are tracked in [features](../features.md). Items marked as open in [open decisions](#open-decisions) are not settled by this document; they are not implemented until their decision is recorded here.

## Decisions in force

- Decision D3 of the [terminal plan](../plans/terminal-plan.md#32-event-path-decision-d3): file events observed by the terminal sidecar are the only messaging event path. Agent hooks (Claude Code `FileChanged`, Codex hook events) are not on the delivery path. A message is delivered the same way whichever agent wrote the file.
- Decision D4 of the [terminal plan](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4): input injection into the registered terminal is the baseline channel. The MCP tools `messages.read` and `messages.wait` are the better channel where the agent supports MCP tools. Delivery does not depend on a skill.
- The sidecar does not poll. It observes folder changes through an event source. The rule of [AGENTS](../../AGENTS.md) applies: file watching uses a maintained library of the ecosystem. The library is not named in this document ([open decisions](#open-decisions), question 1).

## Registered folder

A terminal registers a folder through a declared request to its terminal sidecar. The request carries the `surface` of the terminal, as every sidecar request does ([sidecars](sidecars.md#messages)). The sidecar sends events only for a surface that sent it a request ([sidecars](sidecars.md#failure), the failure rule for a message to a surface the host never sent to that process).

When the host sends `closed` for a surface, the sidecar releases the resources of that surface, such as its watches, and then replies `{"surface": id, "closed": true}`; it replies with `error` when it cannot release them ([sidecars](sidecars.md#messages)).

The command that registers a folder, its parameters, and its reply are open ([open decisions](#open-decisions), questions 2 and 3).

## File event

A file event is delivered to the page of the surface as a sidecar message. The host delivers each sidecar message only to the window that first sent for the surface, as the `sidecar-message` event `{sidecar, surface, cids, body}` ([sidecars](sidecars.md#messages)). A page receives the body through `on(surface, fn)` ([page interface](sidecars.md#page-interface)).

The plan requires one event per change, with its source and a sequence number ([terminal plan, 3.5](../plans/terminal-plan.md#35-red-and-green-for-f899-7)). The body of the event, the source value, the sequence scope, and the event name in the sidecar catalog ([logging](logging.md#sidecar-catalogs)) are open ([open decisions](#open-decisions), questions 4 and 5).

## Message

A message is a file written in a registered folder. The file format, the file name, the location inside the folder, the reading procedure, the consumption of a read message, and the order and repetition of messages are open ([open decisions](#open-decisions), questions 6 to 8).

## Missing folder

A registered folder that does not exist is a failure. The rules that apply are that missing operations and sidecar errors are failures and are not replaced or discarded ([sidecars](sidecars.md#messages)), and that a boundary rejects an invalid value with an explicit error ([AGENTS](../../AGENTS.md)). The reply for a folder that is missing at registration, and the behavior for a folder removed or renamed after registration, are open ([open decisions](#open-decisions), questions 3 and 9).

## Input injection

A trigger acts through the terminal. It injects input into the registered terminal, or it runs a declared command. No agent API is used ([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).

The sidecar receives input through the `input` and `paste` operations of its session ([persistent services](persistent-services.md#destructive-command-guard)). Each submitted line that these operations carry is judged by the destructive command guard. A line that a declared rule matches, or whose command cannot be decided, is refused with the error `guardRefused` and writes no byte to the session ([persistent services](persistent-services.md#destructive-command-guard)). Whether an injected message passes this guard is open ([open decisions](#open-decisions), question 10).

The declared command that carries an injected message, and the form of a message in the input, are open ([open decisions](#open-decisions), questions 11 and 12). A terminal whose agent is busy in a foreground TUI receives input only through the background or send-now action of the TUI adapter ([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)); which action a message uses is open (question 13).

## MCP tools

The sok MCP server exposes a fixed set of tools, and no tool is made from the exposure ([cli](cli.md#mcp-server), the rule of the tool table). The messaging tools are `messages.read` and `messages.wait`, as the feature row names them.

| Tool | Arguments | Reply |
| --- | --- | --- |
| `messages.read` | open (question 14) | open (question 15) |
| `messages.wait` | open (question 16) | open (question 17) |

The names are dotted, but every tool of the table in [cli](cli.md#mcp-server) has an underscore name, such as `windows_list` and `status_get`. The naming form is open (question 18).

A refused or failed call returns an explicit error and is never reported as an empty result, because every error is reported ([AGENTS](../../AGENTS.md)). A tool call that fails returns a tool error, as [cli](cli.md#mcp-server) defines for the other tools. The error text of each messaging tool is open with its reply.

The agent uses the MCP tools only where its client supports MCP tools ([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)). How the sidecar or the trigger learns that an agent supports them is open (question 19).

## Open decisions

Each question states the reason it is open.

1. Which maintained library watches folders on each platform. Reason: AGENTS requires a maintained library for file watching, and the repository does not name one for this contract.
2. Which declared request registers a folder, and its parameters. Reason: the plan names the registration only as "a terminal registers a folder" ([terminal plan, 3.1](../plans/terminal-plan.md#31-requirement)).
3. The reply of a registration, and its error texts for a folder that is missing, is not a directory, or is already registered by another surface. Reason: the plan does not define a reply.
4. The body of a file event: its fields, its kind of change, and the path it names. Reason: the plan requires a source and a sequence number but defines neither.
5. The sequence number and source of a file event: their scope (per registration, per folder, per sidecar run, or per boot), and what the source names. Reason: the plan does not define the scope; the event log requires a sequence in the form of [logging](logging.md#event).
6. The format of a message file (for example JSON or text, and its maximum size), its file name rule, and the folder in which it is written. Reason: the plan does not define the message format.
7. Whether a read message is consumed, moved or left in place, and how a repeated read of the same message behaves. Reason: the plan does not define consumption.
8. The order of messages when several arrive together, and the handling of a message that is written again. Reason: the plan does not define ordering or repetition.
9. Behavior when a registered folder is removed or renamed after registration, including whether the watch ends with an explicit event, and whether a re-created folder resumes the watch. Reason: the plan covers only the registration of an existing folder.
10. Whether an injected message passes the destructive command guard, and whether a message that a guard rule matches is refused or reported differently. Reason: the guard judges each submitted line ([persistent services](persistent-services.md#destructive-command-guard)), and a message is submitted input; the plan does not state it.
11. The declared command that carries an injected message into the terminal, and its parameters. Reason: the plan names the trigger path ([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)) but no command.
12. The form of an injected message in the input of the terminal, such as the text, the prefix that marks it as a message, and the submission. Reason: the plan states "one declared form" without defining it ([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)).
13. Which TUI action delivers a message to a busy foreground TUI (background, send-now, or the idle-state queue), and the rule for each agent. Reason: the adapter action keys are defined per agent and are not yet declared ([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)).
14. The arguments of `messages.read`. Reason: the plan names the tool only.
15. The reply of `messages.read`: its member names, the order of messages, and the error text for an unknown terminal. Reason: the plan states that the result is structured but defines no shape.
16. The arguments of `messages.wait`. Reason: the plan names the tool only.
17. The reply of `messages.wait` on arrival, on timeout, and on client cancellation. Reason: the plan does not define them; [cli](cli.md#mcp-server) defines the cancellation of the status watch as a precedent, not a decision for this tool.
18. The naming form of the two tools: dotted, as the feature row names them, or underscore, as every tool of [cli](cli.md#mcp-server) has. Reason: the two forms conflict, and the decision changes the tool table.
19. How the sidecar or the trigger learns that an agent supports MCP tools, and whether the adapter declares it per action ([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)). Reason: the plan states the condition but no declaration.
20. The time limit of a waiting `messages.wait` call in Claude Code and Codex. Reason: plan open item V7 is unmeasured ([terminal plan, 3.6](../plans/terminal-plan.md#36-open-items-in-part-3)).
21. The delivery latency bound of file events on the shared machine. Reason: plan open item V6 is unmeasured; the plan states that no bound is written before measurement ([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).
22. Whether Claude Code has a same-machine direct path for session messages. Reason: plan open item V8 is unrecorded ([terminal plan, 3.6](../plans/terminal-plan.md#36-open-items-in-part-3)).
23. The transport of the file-watching sidecar, `stdio` or `persistent`, and whether its watches survive a reconnection of a persistent service. Reason: the persistent service contract defines reconnection for sessions ([persistent services](persistent-services.md#service-transport)) and does not name watches.
24. The event names in the sidecar catalog for file events, registration, and message delivery, and their gate levels in the event log ([logging](logging.md#sidecar-catalogs)). Reason: no event name is declared.
