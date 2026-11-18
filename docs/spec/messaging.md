# Messaging

[한국어](messaging.ko.md)

This document defines the messaging contract between terminals and agents. Implementation and verification are tracked in [features](../features.md). Items marked as open in [open decisions](#open-decisions) are not settled by this document; they are not implemented until their decision is recorded here.

## Decisions in force

- Decision D3 of the [terminal plan](../plans/terminal-plan.md#32-event-path-decision-d3): file events observed by the terminal sidecar are the only messaging event path. Agent hooks (Claude Code `FileChanged`, Codex hook events) are not on the delivery path. A message is delivered the same way whichever agent wrote the file.
- Decision D4 of the [terminal plan](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4): input injection into the registered terminal is the baseline channel. The MCP tools `messages_read` and `messages_wait` are the better channel where the agent supports MCP tools. Delivery does not depend on a skill.
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

The sidecar receives input through the `input` and `paste` operations of its session ([persistent services](persistent-services.md#destructive-command-guard)). Each submitted line that these operations carry is judged by the destructive command guard. A line that a declared rule matches, or whose command cannot be decided, is refused with the error `guardRefused` and writes no byte to the session ([persistent services](persistent-services.md#destructive-command-guard)). An injected message is judged by this guard ([settled](#settled-by-existing-contracts)).

The form of a message in the input is open ([open decisions](#open-decisions), question 10). A terminal whose agent is busy in a foreground TUI receives input only through the background or send-now action of the TUI adapter ([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)); which of the two each agent uses is open (question 11).

## MCP tools

The sok MCP server exposes a fixed set of tools, and no tool is made from the exposure ([cli](cli.md#mcp-server), the rule of the tool table). The messaging tools are `messages_read` and `messages_wait`.

| Tool | Arguments | Reply |
| --- | --- | --- |
| `messages_read` | open (question 12) | open (question 13) |
| `messages_wait` | open (question 14) | open (question 15) |

Every tool of the table in [cli](cli.md#mcp-server) has an underscore name, such as `windows_list` and `status_get`; the messaging tools follow the same form ([settled](#settled-by-existing-contracts)).

A refused or failed call returns an explicit error and is never reported as an empty result, because every error is reported ([AGENTS](../../AGENTS.md)). A tool call that fails returns a tool error, as [cli](cli.md#mcp-server) defines for the other tools. The error text of each messaging tool is open with its reply.

The agent uses the MCP tools only where its client supports MCP tools ([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)). How the sidecar or the trigger learns that an agent supports them is open (question 16).

## Open decisions

Each question states the reason it is open.

1. Which maintained library watches folders on each platform. Reason: AGENTS requires a maintained library for file watching, and the repository does not name one for this contract. The one folder-watching library the repository uses, `@parcel/watcher`, serves its Node test tooling and carries a local FSEvents patch; that use does not decide the sidecar's library.
2. Which declared request registers a folder, and its parameters. Reason: the plan names the registration only as "a terminal registers a folder" ([terminal plan, 3.1](../plans/terminal-plan.md#31-requirement)).
3. The reply of a registration, and its error texts for a folder that is missing, is not a directory, or is already registered by another surface. Reason: the plan does not define a reply.
4. The body of a file event: its fields, its kind of change, and the path it names. Reason: the plan requires a source and a sequence number but defines neither.
5. The sequence number and source of a file event: their scope (per registration, per folder, per sidecar run, or per boot), and what the source names. Reason: the plan does not define the scope; the event log requires a sequence in the form of [logging](logging.md#event), which assigns `seq` per process writer for log records only and does not define the sequence of a delivered file event.
6. The format of a message file (for example JSON or text, and its maximum size), its file name rule, and the folder in which it is written. Reason: the plan does not define the message format.
7. Whether a read message is consumed, moved or left in place, and how a repeated read of the same message behaves. Reason: the plan does not define consumption.
8. The order of messages when several arrive together, and the handling of a message that is written again. Reason: the plan does not define ordering or repetition.
9. Behavior when a registered folder is removed or renamed after registration, including whether the watch ends with an explicit event, and whether a re-created folder resumes the watch. Reason: the plan covers only the registration of an existing folder.
10. The form of an injected message in the input of the terminal, such as the text, the prefix that marks it as a message, and the submission. Reason: the plan states "one declared form" without defining it ([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)).
11. Which action of the TUI adapter, background or send-now, delivers a message to a busy foreground TUI for each agent, and the keys of each action. Reason: the plan requires one of the two actions ([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)), but no agent key is declared; the key table of the TUI adapter is empty, so no key is observed.
12. The arguments of `messages_read`. Reason: the plan names the tool only.
13. The reply of `messages_read`: its member names, the order of messages, and the error text for an unknown terminal. Reason: the plan states that the result is structured but defines no shape.
14. The arguments of `messages_wait`. Reason: the plan names the tool only.
15. The reply of `messages_wait` on arrival, on timeout, and on client cancellation. Reason: the plan does not define them; [cli](cli.md#mcp-server) defines the cancellation of the status watch as a precedent, not a decision for this tool.
16. How the sidecar or the trigger learns that an agent supports MCP tools, and whether the adapter declares it per action ([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)). Reason: the plan states the condition but no declaration.
17. The time limit of a waiting `messages_wait` call in Claude Code and Codex. Reason: measurement; plan open item V7 is unmeasured ([terminal plan, 3.6](../plans/terminal-plan.md#36-open-items-in-part-3)).
18. The delivery latency bound of file events on the shared machine. Reason: measurement; plan open item V6 is unmeasured, and the plan states that no bound is written before measurement ([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).
19. Whether Claude Code has a same-machine direct path for session messages. Reason: measurement; plan open item V8 is unrecorded, and the strings observed so far do not show one ([terminal plan, 3.6](../plans/terminal-plan.md#36-open-items-in-part-3)).
20. The transport of the file-watching sidecar, `stdio` or `persistent`, and whether its watches survive a reconnection of a persistent service. Reason: the persistent service contract defines reconnection for sessions ([persistent services](persistent-services.md#service-transport)) and does not name watches.
21. The event names in the sidecar catalog for file events, registration, and message delivery, and their gate levels in the event log ([logging](logging.md#sidecar-catalogs)). Reason: no event name is declared; the catalog form is fixed, but the names are not.

## Settled by existing contracts

- Tool names: the two MCP tools are named with underscores, as every tool of [cli](cli.md#mcp-server) is (`messages_read`, `messages_wait`). This document uses these names in its tool table.
- Guard: an injected message is submitted through the same `input` operation as a typed line, so the destructive command guard judges it like any submitted line ([persistent services](persistent-services.md#destructive-command-guard)). A refused message gets the reply `guardRefused` with its `rule` and `reason`.
- Carrier: an injected message reaches the terminal through the `input` operation of its session, the operation that carries a typed line ([persistent services](persistent-services.md#destructive-command-guard)). The parameters of that operation are declared by the terminal sidecar in its own repository, not by this repository ([AGENTS](../../AGENTS.md#structure)).
- Busy foreground TUI: delivery to a busy foreground TUI requires the background or send-now action of the TUI adapter. The plan states that such a TUI does not receive a message until one of them runs ([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)).
