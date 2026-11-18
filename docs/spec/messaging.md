# Messaging

[한국어](messaging.ko.md)

This document defines the messaging contract between terminals and agents. Implementation and verification are tracked in [features](../features.md). Items listed in [open decisions](#open-decisions) are not settled by this document; they are not implemented until their decision is recorded here.

## Decisions in force

- Decision D3 of the [terminal plan](../plans/terminal-plan.md#32-event-path-decision-d3): file events observed by the terminal sidecar are the only messaging event path. Agent hooks (Claude Code `FileChanged`, Codex hook events) are not on the delivery path. A message is delivered the same way whichever agent wrote the file.
- Decision D4 of the [terminal plan](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4): input injection into the registered terminal is the baseline channel. The MCP tools `messages_read` and `messages_wait` are the better channel where the agent supports MCP tools. Delivery does not depend on a skill.
- The sidecar does not poll. It observes folder changes through an event source, the Rust crate `notify` ([settled](#settled-decisions)). The rule of [AGENTS](../../AGENTS.md#implementation) applies: file watching uses a maintained library of the ecosystem.

## Registered folder

A terminal registers a folder with the request `messages.register` to its terminal sidecar, with the parameter `folder`, an absolute path. The request carries the `surface` of the terminal, as every sidecar request does ([sidecars](sidecars.md#messages)). The sidecar sends events only for a surface that sent it a request ([sidecars](sidecars.md#failure), the failure rule for a message to a surface the host never sent to that process).

The reply is `{registration, folder}`, where `registration` is an identifier that the sidecar assigns and that is unique within its process. A request for a folder that does not exist fails with `folder-missing`; a path that is not a directory fails with `not-a-directory`. A request for a folder that another surface has registered fails with `already-registered`. A repeated request from the same surface for the same folder returns the same reply, because the operation is idempotent ([AGENTS](../../AGENTS.md#implementation)). Each error is an explicit error reply and is not replaced by an empty result.

When the host sends `closed` for a surface, the sidecar releases the resources of that surface, such as its watches, and then replies `{"surface": id, "closed": true}`; it replies with `error` when it cannot release them ([sidecars](sidecars.md#messages)).

## File event

A file event is delivered to the page of the surface as a sidecar message. The host delivers each sidecar message only to the window that first sent for the surface, as the `sidecar-message` event `{sidecar, surface, cids, body}` ([sidecars](sidecars.md#messages)). A page receives the body through `on(surface, fn)` ([page interface](sidecars.md#page-interface)).

The body of a file event is `{registration, path, kind, seq}`:

- `registration` is the identifier of the registration that observed the change.
- `path` is the path of the changed file relative to the registered folder.
- `kind` is `created`, `modified` or `removed`.
- `seq` is the sequence number of the event.

The sidecar sends one event per change of any file in the folder. The sequence number `seq` counts per registration and starts at 1 for each registration in one sidecar process. The source of the event is the registration, which the body names. The `seq` rule of [logging](logging.md#event) assigns one counter per writer process to log records; this contract applies the same counter form to each registration, so a reader orders the events of one folder by one counter. The plan requires a sequence number per event and does not define its scope ([terminal plan, 3.5](../plans/terminal-plan.md#35-red-and-green-for-f899-7)).

The event name in the sidecar catalog is `sidecar.alacritty.file.changed`, the sidecar that watches folders and delivers messages is `alacritty`, the terminal sidecar that holds the terminal session of the agent (the decision of the lead; the sidecar repository already exists). The catalog form requires that prefix for every sidecar event ([logging](logging.md#sidecar-catalogs)); the names given without it are not valid catalog names. The gate level is `debug`, and the class is `io`, which holds sidecar messages ([logging](logging.md#classes-and-policy)). The default policy stores only `error` ([logging](logging.md#policy)), so a file event is stored only when the person enables the `debug` level of the class.

## Message

A message is a file written directly in a registered folder, not in a subfolder. Its file name ends in `.txt`, its content is UTF-8 text, and its size is at most 64 KiB. Files that do not end in `.txt` produce file events but no messages. A file larger than 64 KiB is refused by `messages.read` with the explicit error `message-too-large`, which names the path. The bound is stated because a sidecar buffer must not grow without a limit, and a larger file is reported instead of truncated ([AGENTS](../../AGENTS.md#implementation)).

A message is not consumed. `messages_read` returns the messages with a sequence number greater than `after`, in increasing `seq` order. A repeated read with the same `after` returns the same messages while the folder does not change, because the operation is idempotent ([AGENTS](../../AGENTS.md#implementation)). A file that is written again produces a new `created` or `modified` file event with a new `seq`; it is returned as a new message with that `seq`, and the earlier event is not replaced. The text of a message is read when the reply is built.

## Folder removed or renamed

When the registered folder is removed or renamed, the sidecar sends the event `sidecar.alacritty.registration.closed` with `{registration, reason: "folder-removed"}` at the gate level `info`, and it ends the watch of that registration. The event is explicit, and the sidecar does not poll for the folder ([AGENTS](../../AGENTS.md#implementation)). A folder that is created again at the same path does not resume the watch: the agent registers the folder again, and the new registration starts its `seq` at 1.

## Missing folder

A registered folder that does not exist is a failure. The rules that apply are that missing operations and sidecar errors are failures and are not replaced or discarded ([sidecars](sidecars.md#messages)), and that a boundary rejects an invalid value with an explicit error ([AGENTS](../../AGENTS.md#implementation)). A missing folder at registration is `folder-missing`; a folder removed after registration ends the registration with the event of [Folder removed or renamed](#folder-removed-or-renamed).

## Input injection

A trigger acts through the terminal. It injects input into the registered terminal, or it runs a declared command. No agent API is used ([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).

The sidecar receives input through the `input` and `paste` operations of its session ([persistent services](persistent-services.md#destructive-command-guard)). Each submitted line that these operations carry is judged by the destructive command guard. A line that a declared rule matches, or whose command cannot be decided, is refused with the error `guardRefused` and writes no byte to the session ([persistent services](persistent-services.md#destructive-command-guard)). An injected message is judged by this guard ([settled](#settled-decisions)).

The form of a message in the input is open ([open decisions](#open-decisions), item 1). A terminal whose agent is busy in a foreground TUI receives input only through the background or send-now action of the TUI adapter ([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)); which of the two each agent uses is held ([open decisions](#open-decisions), item 2).

## MCP tools

The sok MCP server exposes a fixed set of tools, and no tool is made from the exposure ([cli](cli.md#mcp-server), the rule of the tool table). The messaging tools are `messages_read` and `messages_wait`. Each calls the sidecar operation of the same dotted name, `messages.read` and `messages.wait`.

| Tool | Arguments | Reply |
| --- | --- | --- |
| `messages_read` | `{terminal, after}`; `after` is optional and defaults to 0 | `{messages: [{seq, path, text}], last}`; `last` is the greatest `seq` of the registration when the reply is built, and the caller passes it as the next `after`. An unknown terminal fails with `unknown-terminal`. |
| `messages_wait` | `{terminal, after}`; `after` is optional and defaults to 0 | On arrival, the same shape as `messages_read`. The call has no time limit and no timer: it ends on arrival, on the cancellation of the caller, or when the registration of its folder is closed, which fails with `registration-closed` and the reason of the close. An unknown terminal fails with `unknown-terminal`. |

The wait ends on arrival or on an event that closes the registration; no timer ends it, because a wait is an event wait and the rule of [AGENTS](../../AGENTS.md#implementation) allows a timer only when no event source exists. A cancelled call ends without a result, as the status watch does ([cli](cli.md#mcp-server)).

Every tool of the table in [cli](cli.md#mcp-server) has an underscore name, such as `windows_list` and `status_get`; the messaging tools follow the same form ([settled](#settled-decisions)).

A refused or failed call returns an explicit error and is never reported as an empty result, because every error is reported ([AGENTS](../../AGENTS.md#implementation)). A tool call that fails returns a tool error, as [cli](cli.md#mcp-server) defines for the other tools.

The agent uses the MCP tools only where its client supports MCP tools ([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)). The agent catalog of the terminal sidecar declares, for each agent, whether its client supports MCP tools. Claude Code and Codex are declared as supporting them. A test checks the declaration. The reason is that the repository holds no runtime source that reports the MCP support of an agent, so a declaration is the only source ([settled](#settled-decisions)).

## Open decisions

Each item states the reason it is open.

1. The form of an injected message in the input of the terminal: its visible text, the prefix that marks it as a message, and the submission. Decision needed: the text is what a person reads on the agent's input line, and the repository cannot choose its wording. Source of the gap: the plan states "one declared form" without defining it ([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)).
2. Which action of the TUI adapter, background or send-now, delivers a message to a busy foreground TUI for each agent, and the keys of each action. Held: the key table of the TUI adapter is empty, so no key is observed. Resume when the keys are observed, because the TUI adapter's delivery of a message depends on this same fact ([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)).
3. The delivery latency bound of file events on the shared machine. Held for measurement: plan open item V6 is unmeasured, and the plan states that no bound is written before measurement ([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).
4. Whether Claude Code has a same-machine direct path for session messages. Held for measurement: plan open item V8 is unrecorded, and the strings observed so far do not show one ([terminal plan, 3.6](../plans/terminal-plan.md#36-open-items-in-part-3)).

## Settled decisions

- Watcher library: the Rust crate `notify`, a maintained library that uses FSEvents on macOS. Reason: [AGENTS](../../AGENTS.md#implementation) requires a maintained library for file watching instead of a new implementation. The one folder-watching library this repository uses, `@parcel/watcher`, serves its Node test tooling, and that use does not decide the sidecar's library. Source of the sidecar language: the terminal sidecar is implemented in its own repository, which this repository does not declare; the choice of `notify` follows the Rust implementation named in the plan.
- Transport of the file-watching sidecar: `transport: "persistent"`. Reason: a registration must survive a reconnection of the persistent service, and [persistent services](persistent-services.md#service-transport) states that reconnection restores the sessions of the service ("Reconnection restores the same session, child process, and session state"). That rule names sessions and not watches, so the watch survival is a requirement of this contract. [Sidecars](sidecars.md#failure) states that a new process after a failure has none of the sessions of the failed process, so a standard input and output sidecar would lose its watches when its process ends.
- Request: `messages.register` with the parameter `folder`, an absolute path. Reason: it uses the dotted operation style of `screen.read` ([persistent services](persistent-services.md#screen-message)).
- Registration reply and errors: `{registration, folder}`; `folder-missing`, `not-a-directory` and `already-registered`. Reason: a reply and explicit errors are required, and the sidecar reports each of these conditions. The reply shape is the one given in [Registered folder](#registered-folder).
- Sequence scope: per registration, starting at 1 in one sidecar process. Reason: [logging](logging.md#event) assigns `seq` as a counter per writer, and a per-registration counter gives a reader one order per folder.
- Message format: a `.txt` file in the registered folder, UTF-8, at most 64 KiB, with the refusal `message-too-large` for a larger file. Reason: a text file is the simplest format that a terminal agent writes, and the bound follows [AGENTS](../../AGENTS.md#implementation) for bounded buffers.
- Consumption: messages are not consumed; `messages_read` takes `after` and returns the messages with a greater `seq`, and a repeated read with the same `after` returns the same result. Reason: [AGENTS](../../AGENTS.md#implementation) requires idempotent operations.
- Order and rewritten files: messages are delivered in increasing `seq`; a rewritten file is a new file event with a new `seq`, not a replacement of the earlier one. Reason: the `seq` rule of [logging](logging.md#event) orders the events of one counter, and [AGENTS](../../AGENTS.md#implementation) requires idempotent operations, which a replacement would break.
- Removed or renamed folder: the sidecar sends `sidecar.alacritty.registration.closed` with `reason: "folder-removed"`; a re-created folder does not resume the watch. Reason: [AGENTS](../../AGENTS.md#implementation) forbids polling where an event source exists, and the removal of a folder is an event that the watch receives.
- Waiting call: `messages_wait` takes `{terminal, after}` and has no time limit. Reason: the wait is an event wait that ends on arrival, on caller cancellation, or on the close of its registration, so no timer is needed ([AGENTS](../../AGENTS.md#implementation)). The time limit of a waiting call is closed by this decision.
- Event names and gate levels: `sidecar.alacritty.file.changed` at `debug` in class `io`, `sidecar.alacritty.messages.registered` at `info` and `sidecar.alacritty.registration.closed` at `info` in class `lifecycle`. Reason: a sidecar event carries the sidecar prefix ([logging](logging.md#sidecar-catalogs)); `info` is a change of an object's lifetime and `debug` is a crossing of a boundary ([logging](logging.md#event)); the class follows the table of [logging](logging.md#classes-and-policy).
- Agent MCP support: a static declaration per agent in the agent catalog of the terminal sidecar, with Claude Code and Codex declared as supporting MCP tools, checked by a test. Reason: the repository holds no runtime source that reports the MCP support of an agent ([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)).
- Tool names: the two MCP tools are named with underscores, as every tool of [cli](cli.md#mcp-server) is (`messages_read`, `messages_wait`). This document uses these names in its tool table.
- Guard: an injected message is submitted through the same `input` operation as a typed line, so the destructive command guard judges it like any submitted line ([persistent services](persistent-services.md#destructive-command-guard)). A refused message gets the reply `guardRefused` with its `rule` and `reason`.
- Carrier: an injected message reaches the terminal through the `input` operation of its session, the operation that carries a typed line ([persistent services](persistent-services.md#destructive-command-guard)). The parameters of that operation are declared by the terminal sidecar in its own repository, not by this repository ([AGENTS](../../AGENTS.md#structure)).
- Busy foreground TUI: delivery to a busy foreground TUI requires the background or send-now action of the TUI adapter. The plan states that such a TUI does not receive a message until one of them runs ([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)).
