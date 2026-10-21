# The sidecar route of a plugin host

[한국어](plugin-host-routes.ko.md)

The decision of F229 and its review record. Remove this document after the decision is in [plugin host](../spec/plugin-host.md) and the implementation items of F229 are complete.

## Problem

A plugin whose sidebar section shows values that its sidecar computes from the project folder (for example a listing of the folder as a declared tree) has no source for those values while none of its views is open:

- A [plugin host](../spec/plugin-host.md) is the second source of a declared status, but its channel serves only the registration calls and the state calls. It answers every other call with `plugin host call <name> is not served` and has no sidecar send ([plugin host](../spec/plugin-host.md#channel)).
- A sidecar is no declared status source: the source of a declared status is a process that registers the status and pushes declared UI snapshots ([declared UI](../spec/declared-ui.md#declared-status)), and a sidecar does neither.

## Scope

F229 is the minimal generic route by which a plugin host sends to and receives from the sidecars that its manifest declares, checked against its own plugin. Nothing else is in F229. Behavior that exists outside this route is a separate sub-item (F229-n, listed below), not an objection to this decision.

## Options

1. **The plugin host gets a sidecar route.** The host page sends to and subscribes to the sessions of its own plugin's declared sidecars through its channel; the main page answers these calls.
2. **A sidecar supplies declared values directly.** A sidecar registers declared statuses and pushes snapshots. Rejected: a declared status binds commands of its plugin and needs a process that registers them, so a sidecar source would still need a view or a plugin host for every command. A sidecar process serves several windows and processes, and a declared status source is a process and its registration, so the source transitions of [declared UI](../spec/declared-ui.md#declared-status) would need a second form. Every sidecar would also implement the snapshot protocol in its own repository.

Decision: option 1.

## The route

1. **Served calls.** The channel of a plugin host serves, beside the registration calls and the state calls, `runtime.sidecar.send`, `runtime.sidecar.on` and `runtime.sidecar.onFailure`. The host forwards each to the main page as `plugin-host-call {plugin, id, command, params}`, as it forwards a registration call. Every other name, including every `core.` name, is refused with `plugin host call <name> is not served`. Core commands are not part of F229 (F229-5).
2. **Checks of the main page.** A sidecar call of a plugin host is answered by a route that is bound to the plugin of the host, not to a surface. The host call `pluginHostSidecarSend` is accepted only from the main webview of the window, by the main-page check that the host applies to operations of a surface (`authorize_main_caller`, `packages/host/tauriv2/src/exposure.rs` 698 to 709); its `plugin` argument is the plugin of the `plugin-host-call` that the main page answers. The sidecar name must be one that the plugin lists in `dependencies` of its `plugin.json`; any other name is refused with `plugin host <plugin> cannot use sidecar <name>`. The session id has the form `plugin:<plugin id>:<project id>:<sidecar name>`, where the project id is the id of a project that the sender's window holds; a project id that the window does not hold is refused with `plugin host <plugin>: project <id> is not held by this window`. No id contains `:` (`validProjectID` in `packages/host/wailsv3/src/projects.go` and the inline check in `packages/host/tauriv2/src/windows.rs` 786 to 792), so the id parses. The project id keys the root of rule 3. A project has one holding window (`h.owners` in `projects.go`, set at line 145), so one session id has one holding window at a time. Any other session id is refused with `plugin host <plugin> cannot use sidecar session <id>`. A view call whose session id begins with `plugin:` is refused by the view route with `sidecar session <id> is reserved for a plugin host`. The plain `sidecarSend` call of a window is refused for every `plugin:` surface, so a view cannot reach a plugin session through it, and a plugin host reaches its session only through the call of rule 3.
3. **Send.** A plugin host send is the host call `pluginHostSidecarSend {plugin, sidecar, id, body, cids}` in Go and Rust. Its handler checks the prefix and the plugin of rule 2 and then runs the existing send path of the sidecar, with the session as a surface id. The existing owner record of the sidecar then applies to the session: the first send records the window as the owner, and a send from another window is refused by the existing check. A plugin session takes the root of its project at its first send, as a surface takes the root of its window today. Each window records the folder root of each project that it holds: `ProjectOpen` writes the root of the project to the holding window in both of its branches (a new holding, and a re-open of a project that another window holds; `projects.go` 119 to 124 and 141 to 144). In Go the record is `Surfaces.projects` (`surfaces.go` 251), changed from a set to a map of project id to root; in Rust it is a map in `WindowData` (`packages/host/tauriv2/src/windows.rs` 27), written by `project_open_on_main` (`windows.rs` 786 to 820). The send path takes the root as an argument: a surface send passes the window root as today, and a plugin send passes the recorded root of its project in place of the window root (Go `sidecars.go` 436 to 441; Rust `send` in `sidecars.rs` 1149). A send whose project has an empty recorded root is refused before any start or record with `plugin host <plugin>: project <id> has no folder`, and an empty root is never recorded, so `Retain` never sees one. The session keeps that root until its owner closes it. F229-1 defines the lifetime of the record across a project change.
4. **Events.** A sidecar message or failure of a plugin session reaches the owner window through the existing `sidecar-message` and `sidecar-failure` events. The host page subscribes through `runtime.sidecar(name).on(id, listener)` and `.onFailure(id, listener)`; the view bridge in `packages/plugin-api/view.js` changes from `sidecar()` to `sidecar(name)`, and its requests carry `{id, sidecar}`, as the specification list states. The main page records each subscription in `packages/workbench/plugin-host.js` under the plugin, the sidecar and the session id, and it posts a matching message or failure to the host page as `pluginHostEvent {plugin, event, sidecar, id, body}` or `{..., reason}`. F229 makes `packages/workbench/host.js` hand a `plugin:` message or failure to `plugin-host.js` before the surface listener (`windowSidecar`, line 183) and before the failure dispatch (`listenSidecarFailures`, lines 146 to 154), so no alert is shown for a plugin session. A message or failure of a plugin session whose kind has no subscription is dropped and written at `warn` as `plugin host <plugin>: sidecar <name> <event> for <session> dropped: no subscription`, because the sidecar produced data that the page did not receive (`docs/spec/logging.md`: `warn` is a loss). A failed post to the host page is logged as in rule 5. A sidecar failure is logged once by the existing `failed:` error of the sidecar process (`sidecars.go` 1610), and this route adds no log line for it.
5. **Errors.** A refused call, including a call that rule 1 does not serve, is answered to the calling host page with its error text and is written to the application log at `error` as `error: plugin host <plugin>: <reason>`. The error texts are those of rules 1 to 3 and every error that the send path returns (`sidecars are stopped`, `sidecar <name> is not declared by any plugin`, the owner refusal `surface <id> belongs to another window`, the errors of starting the process, and `sidecar <name> is not keeping up`; `sidecars.go` 476 to 518), and each is passed to the host page unchanged. The restart-limit refusal is the exception: `restartRefused` writes it for each refused request, and rule 6 states it, so this rule does not write it again. A post that the host refuses (no ready document or a refusal of the document) is written at `error` with its reason.
6. **Failures and the restart limit.** For a standard input and output sidecar, a send whose sidecar fails ends as the sidecar failure contract states for any session ([sidecars](../spec/sidecars.md#failure)), and the restart limit counts the failure as any other. The restart limit of a persistent sidecar is not defined by the specification, and this rule does not apply to it. The failure record is per sidecar name, so the plugin sessions share it with every other session of the sidecar. Below the restart limit, the host page's next request starts a new process, and the host page opens its session again. After the limit stops the sidecar, each request for it is refused with `sidecar <name>: restart limit`. `restartRefused` (`sidecars.go` 254 to 260) writes `error` for each refused request, and the owner receives `sidecar-failure` with reason `restart limit`. A refused request is not counted. The stop is cleared only as [sidecars](../spec/sidecars.md#failure) states, by a surface of a plugin that lists the sidecar in `dependencies`; a plugin host creates no surface, so its requests alone do not clear the stop (the plugin host stop rule is F229-6). The host page's failure handler sends nothing, so a refusal gives no resend. The main page sends nothing on its own: each sidecar send is the answer to a request of the host page.

## Specification changes of the item

- `docs/spec/plugin-host.md` line 59 replaces the sentence that a plugin host has no sidecar send with the served calls of rule 1 and the checks of rule 2.
- `docs/spec/plugin-host.md` line 48 removes the synchronous `project` value of the host page, which no code injects (F229-1 owns the project value).
- `docs/spec/sidecars.md` states the plugin session id form, the `pluginHostSidecarSend` call and the shared failure record of plugin sessions.
- `docs/spec/declared-ui.md` states that a declared section of a plugin host draws the snapshot that the host page pushes.
- `docs/spec/host-contract.md` line 837 (`plugin-host.channel.call-served-set`) lists the served set of rule 1; the contract cases of `pluginHostSidecarSend` and of the three `runtime.sidecar` calls are added to both hosts.
- `docs/spec/declared-ui.md` and `docs/spec/plugins.md`: the bridge is `runtime.sidecar(name)`, the view bridge gains the `sidecar` parameter, and `packages/plugin-api/view.js` lists the change; its test changes with it.
- The Korean translations of every changed specification file are part of the same change.
- `docs/features.md` and `docs/features.ko.md` register F229 and F230 under F212.

## Sub-items outside F229

These are objections raised in the review that concern behavior outside the route. Each is registered as its own item with its evidence, and none is part of the F229 decision.

- **F229-1** The shown project of a window and the lifetime of plugin sessions across a project change. Evidence: `ProjectOpen` changes `owner.root` in the local branch and returns only `{Local}` (`packages/host/wailsv3/src/projects.go` 96 to 132; `packages/host/tauriv2/src/windows.rs` ~796 to 815); `activateInTurn` switches the project of a window without an event (`packages/workbench/projects.js` 339 to 352); `ProjectRelease` clears the root only when no project is left (`projects.go` 172 to 192).
- **F229-2** Closing a plugin session at the end of its host, at a page start and at a reload. Evidence: the disposal at page start (`packages/host/wailsv3/src/start.go` 74 to 82; `packages/host/tauriv2/src/windows.rs` 984 to 991) emits no `plugin-host-ended`.
- **F229-3** `closeSurface` sends `closed` to every running sidecar (`packages/host/wailsv3/src/sidecars.go` 591 to 629); a close of one session should reach the sidecar that holds it.
- **F229-4** A reply to an owner-less session is written by `dropMessage` at `info` (`sidecars.go` 2064 to 2067); the level is checked against the logging contract.
- **F229-5** A core command route for plugin hosts. No plugin host needs one for the stated problem. It is a separate decision with its own review.
- **F229-6** The restart stop clear rule: a sidecar stop clears by a surface of any plugin that depends on it (`sidecars.md`); a plugin host stop clears by a surface of its own plugin (`plugin-host.md` line 80). The two rules are stated as they are in each specification; the joint rule needs its own decision.
- **F229-7** The retain of a window keeps every session that the process has sent to, and both hosts build the `keep` list before a service is started (`sidecars.go` 945 to 972; `packages/host/tauriv2/src/sidecars.rs` ~1576 to 1612). A session first sent during the start is missing from the list.
- **F229-8** The `state:<plugin id>:<project id>` session has the same lifetime defect as F229-1.

## Review record

### Rounds 1 to 3 (summary)

The session close (R1-1), the per-project sessions (R1-2), the root read at the first send (R2-1), the close in flight (R2-2), the project read (R2-3), the subscription lifetime (R2-4), the shown project id (R3-1), the queued close and reopen (R3-2), the view route (R3-3) and the specification sentences (R3-4) were accepted and replaced by the design of the earlier versions. The event order after a project change (R3-5) was rebutted: the replies answer the page's own requests and are delivered by session id.

### Rounds 4 to 8 (summary)

Each round raised objections that were accepted and answered by the rules of its version. The objections that concerned the shown project, its reply shapes and locks, the reload and page start, the close and the retain, and the core command route were the bulk. From round 8 the core command route was removed (F229-5), and the project state and the close lifecycle became separate items (F229-1 and F229-2). The full text of these rounds is in the git history of this file.

### Round 9

Two fresh auditors on the design of round 8. Auditor A delivered before the re-scope: objections O1 (a local project switch sends no event, rule 6 triggers do not cover it) and O2 (the initial shown value of the main page is not defined). Both concern the shown project and are F229-1, not the sidecar route. Auditor B had not delivered when the scope was changed; its objections are on the same design and are not answered here.

Supervisor decision, round 9: the review was not converging, because the design had grown into project ownership, shown state, reloads and window records. F229 is re-scoped to the sidecar route of rules 1 to 6. Objections about behavior outside the route are sub-items (F229-1 to F229-8), and each is a separate item with its evidence.

### Round 10

Two fresh auditors checked rules 1 to 6 against the code. They raised seven distinct objections, and one more was found in the same check. Each was checked in the code and accepted; none was rebutted.

1. Rule 2 gave a reason for the project id: two windows that hold one project. `h.owners` keeps one holding window per project (`projects.go`, line 145), so the reason does not occur. The project id now keys the root of rule 3. Accepted.
2. Rule 3 took the root of the window (`owner.ProjectRoot()`, `sidecars.go` 441), which is one root per window (`projects.go` 143 to 145), not the root of the project named by the id. Rule 3 now takes the root recorded per project, and rule 2 refuses a project that the window does not hold. Accepted.
3. Rule 4 cited `dropMessage` as the precedent for `info`. `dropMessage` covers messages with no owner window (`sidecars.go` 2064), not messages without a subscription, and its level is the open item F229-4. Rule 4 now uses the meaning of `warn` in `logging.md`: a dropped sidecar message is a loss. This replaces the `info` level of round 9. Accepted.
4. Rule 4 said that `listenSidecarFailures` already routes a `plugin:` failure. The function has no such branch (`host.js` 144 to 158). Rule 4 now states the branch as the change that F229 makes. Accepted.
5. Rule 5 covered only the texts of rules 2 and 3. The refusal of rule 1 (`plugin_host_channel.rs` 249 to 256) is not logged, and the owner refusal text was not listed. Rule 5 now covers both. Accepted.
6. Rule 6 said that `restartRefused` logs once. It logs each refused request (`sidecars.go` 254 to 260). Accepted.
7. Rule 6 said that the host page's next request opens the session again. After a restart-limit stop, only a surface of a dependent plugin clears the stop (`sidecars.go` 232 to 250; `sidecars.md`), so the request is refused. Rule 6 now states both cases; the clear rule stays F229-6. Accepted.

Objections: 7 from the auditors and 1 from the check. The sixth objection of one auditor was not recoverable from the collected output, because the output was truncated. Round 11 covers rules 1 to 6 again with two fresh auditors.

### Round 11

Two fresh auditors checked rules 1 to 6 against the code, with the round 10 answers as background. They raised nine distinct objections, all on rules 2 to 6; rule 1 drew none. Each was confirmed in the code and accepted; none was rebutted.

1. Rule 3 gave `owner.projects` as a map of project id to root in both hosts. Go has a set (`surfaces.go` 251, written at `projects.go` 141). Rust has no per-window project record; holding is one global map of project id to window (`windows.rs` 163). The re-open branch (`projects.go` 119 to 124) writes only the window root. Rule 3 now names the record in each host and writes it in both branches. Accepted.
2. Rule 3 did not say how the root reaches the send path. `SendWithCids` takes no root argument, and `SidecarOwner` gives the window root only (`sidecars.go` 135 to 137). Rule 3 now passes the recorded root as the send argument. Accepted.
3. Rule 4 described the view bridge as existing. `packages/plugin-api/view.js` 108 to 110 has `sidecar()` without a name and without `send`. The bridge change is named in rule 4 and in the specification list. Accepted.
4. Rule 4 named no file for the subscription record and the message route. The record is `packages/workbench/plugin-host.js`, which already receives `plugin-host-call`, and `host.js` hands `plugin:` events to it. Accepted.
5. Rule 4 said a failure is logged "as in rule 5", which has no defined level for a failure. The sidecar already logs `failed:` at `error` (`sidecars.go` 1610), so the route adds no line. Accepted.
6. Rules 5 and 6 would log one restart-limit refusal twice in two formats. Rule 5 now leaves the restart-limit refusal to `restartRefused`. Accepted.
7. Rule 5 listed too few errors of the send path (`sidecars.go` 476 to 518). Rule 5 now passes every error that the send path returns, unchanged. Accepted.
8. Rule 6 applied the restart limit to every sidecar. The limit is defined for a standard input and output sidecar only (`sidecars.md`). Rule 6 now states that scope. Accepted.
9. Rule 2: the `plugin` argument of `pluginHostSidecarSend` is supplied by the caller, and the exposure check admits the main webview label. The host call is now limited to the main webview by the main-page check (`authorize_main_caller`, `exposure.rs` 698 to 709), and its plugin is the plugin of the forwarded `plugin-host-call`. Accepted.

Objections: 9 distinct. The output of one auditor ended within its fourth objection, so a fifth one, if any, is not recorded. Round 12 covers rules 1 to 6 again with two fresh auditors.
