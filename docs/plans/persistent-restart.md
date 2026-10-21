# The restart limit of persistent services

[한국어](persistent-restart.ko.md)

The proposal for F212.8a-4 and its review record. Remove this document after the rule is in [terminal runtime](../spec/terminal-runtime.md) and [sidecars](../spec/sidecars.md).

## Problem

[terminal runtime](../spec/terminal-runtime.md) states: "The restart attempts once per disconnect; a failure is reported, and the next send retries the same path." A service that dies right after each revival makes the host revive again on every disconnect: an unbounded respawn loop that needs no send and no action of the person. [sidecars](../spec/sidecars.md) `## Failure` states that its restart limit does not cover the persistent transport.

## Proposal

1. A failure of a persistent service, counted by the restart limit, is one of:
   - the service process ends while the host is neither stopping its sidecars nor replacing the sidecar; the reader's revival counts that end when it runs for it, whether or not the stop below then prevents the spawn, and it otherwise respawns the service through the single creation path after the stale endpoint is removed or none remains;
   - a start failure of the creation path while the host is neither stopping its sidecars nor replacing the sidecar: `the service did not print its endpoint within 30s`, `service exited before endpoint`, `the service did not answer hello within 5s`;
   - the connection ends for a protocol violation while the host is not stopping its sidecars, for one of the reasons that end the connection: the reasons [terminal runtime](../spec/terminal-runtime.md) `### Service transport` names and the close-answer reasons of [sidecars](../spec/sidecars.md) `## Failure`; the reader counts it when it ends the connection, and the service keeps running.
   A disconnect whose revival reattaches a live service is not a failure. One disconnect counts at most one failure, whatever its revival tried: a revival that retries the connect after a refusal counts as one attempt together with its retry, and a disconnect whose revival respawns the service and whose start then fails counts once, as that start failure. A start that a send initiates counts its own failure.
2. The counting follows the standard input and output rule of [sidecars](../spec/sidecars.md) `## Failure`: by the time each failure arrives, no timer, a failure more than 300 seconds before a new failure is not counted, and the fourth failure within 300 seconds stops the restarts, writes `error: sidecar <name>: restart limit: 4 failures within 300 s` and the event `host.sidecar.restart-limit` `{sidecar}` at level error.
3. The stop begins at the fourth failure, before the revival or the send runs the creation path. When the fourth failure is a failed start, the surfaces that have sent to the sidecar receive the connection notice of that failed start with its start error, as for any failed start. When it is the end of the service process, the host counts it and stops before the revival spawns, and the surfaces that have sent receive the connection notice `{"event": "connection", "connected": false, "reason": "restart limit"}`. While the service is stopped, the host runs no revival and no creation. A send fails with `sidecar <name>: restart limit`, the host writes `error: sidecar <name>: restart limit: request for <surface> refused` to its log, and the surface that sent receives its connection notice `{"event": "connection", "connected": false, "reason": "restart limit"}`. No other connection notice is written until the stop is cleared. The restart-limit reports of the persistent transport go through its connection notice only; the stop adds no `sidecar-failure` delivery.
4. Only the person's open of a surface clears the stop, as for the standard input and output transport: when the host creates a surface of a plugin whose `plugin.json` lists the sidecar in `dependencies`, it clears the failure record, writes the event `host.trace.sidecar.restart-reset` `{sidecar, surface}` at level debug, and the next send runs the creation path. A request from a surface that is already open does not clear the stop. The stop holds while the application process runs; a new application process starts with no failure record.
5. [terminal runtime](../spec/terminal-runtime.md) keeps one revival attempt per disconnect and adds this limit. In [sidecars](../spec/sidecars.md) `## Failure`, the restart-limit paragraph replaces its first sentence with one stating that the restart limit applies to a sidecar of either transport and that the failures of the persistent transport are the ones that terminal runtime names, and the later sentence that leaves the persistent limit undefined is removed, and states that the `sidecar-failure` delivery of the refusal sentence is the report of the standard input and output transport, while the persistent transport reports the refused send through its connection notice, as [terminal runtime](../spec/terminal-runtime.md) names. The description of `host.sidecar.restart-limit` in [events](../spec/events.json) becomes "A sidecar of either transport failed for the fourth time within 300 seconds, so the host stopped its restarts (docs/spec/sidecars.md#failure)." The description of `host.trace.sidecar.restart-reset` becomes "A surface that did not send to a sidecar stopped at its restart limit was opened: the host cleared the failure record, and the next request starts the sidecar (docs/spec/sidecars.md#failure)."

## Review scope

- In scope: which events count as a failure; what the stop does; the reset rule; the counting mechanics; the error and event texts; the specification sentences.
- Out of scope: the limit values 300 s and 4 (set for both transports by F212.8a); session preservation and close semantics; the update and replacement flow; how the reader detects the end of the connection; the 30 s and 5 s start bounds.

## Review record

### Round 1

- R1-1: One disconnect could count twice, because the revival retries the connect after a refusal and a revival that respawns the service can fail its own start. Accepted: one disconnect counts at most one failure; a send-initiated start counts its own failure.
- R1-2: The notice of a stopped service had no delivery moment, because no revival runs while stopped, and both hosts put the start error in the notice reason. Accepted with a decision: the notice of the fourth failure keeps its start error, as in the standard transport, whose fourth failure also names its cause; a refused send while stopped carries `restart limit` in its notice, its send error and its refusal log line; no other notice is written.
- R1-3: A new application process starts with an empty failure record, because the record lives in host memory. Accepted: the stop holds while the application process runs.
- R1-4: The description of `host.sidecar.restart-limit` in events.json names only the standard input and output transport. Accepted: the description names either transport.
- R1-5: The refusal log line of the standard transport was missing. Accepted: the refused send writes `error: sidecar <name>: restart limit: request for <surface> refused`.

### Round 2

- R2-1: The fourth failure can be the end of the service process while the revival would still respawn, so there is no failed start and no start error, and the live-vs-closed connection was undefined. Accepted: the stop begins at the fourth failure before the creation path runs; a failed start keeps its start error in the notice, a service end stops before the spawn and carries `restart limit` in the notice; the end is counted when the revival runs for it, whether or not the stop prevents the spawn.
- R2-2: A service that removes its own endpoint on exit leaves the revival on the no-endpoint spawn path, where the literal first bullet counted nothing, so the die-and-clean-up loop respawned unboundedly. Accepted: the revival respawns through the single creation path after the stale endpoint is removed or none remains.
- R2-3: The first sentence of the restart-limit paragraph of sidecars.md still limits the limit to the standard input and output transport. Accepted: that first sentence is replaced, and the undefined-limit sentence is removed.
- R2-4: The persistent transport does deliver `sidecar-failure` on a protocol violation, so the blanket sentence contradicted the specification. Accepted: only the restart-limit reports go through the connection notice; the stop adds no `sidecar-failure` delivery.

### Round 3

- R3-1: The refusal sentence of the restart-limit paragraph mandates a `sidecar-failure` delivery, so a transport-neutral first sentence would mandate it for a persistent refused send against the R2-4 answer. Accepted: the specification change states that the `sidecar-failure` delivery of the refusal sentence is the report of the standard input and output transport, and the persistent transport reports the refused send through its connection notice.
- R3-2: A protocol-violation connection end is neither a process end nor a start failure, so a violating persistent service reconnects and fails without bound, while the same defect in the standard transport stops at the fourth failure. Accepted: a protocol-violation connection end counts as a failure; the reader counts it when it ends the connection, the service keeps running, and the violation's `sidecar-failure` delivery is unchanged.

### Round 4

- R4-1: A service end that a replacement causes would be counted, although the host is not stopping and the revival treats the replaced state as expected, so four updates within 300 s would stop the sidecar. Accepted: the end counts only while the host is neither stopping its sidecars nor replacing the sidecar.
- R4-2: A protocol-violation end during a stop would be counted, while the standard transport logs it without an event and the hosts skip counting while stopping. Accepted: the violation counts only while the host is not stopping its sidecars.
- R4-3: The restart-reset description states a start that the open does not perform; the next request starts the sidecar. Accepted: the description states the clear and the start by the next request.

### Round 5

- R5-1: A wrong close answer also ends the persistent connection, and terminal runtime names only its own violation reasons, so a service that answers closed wrongly reconnects on every send without being counted. Accepted: the third bullet counts every reason that ends the connection, the terminal-runtime reasons and the close-answer reasons of sidecars.
- R5-2: A start failure of the creation path had no replacing exclusion, so repeated failed updates could stop the sidecar and block every later replacement. Accepted: the start failure counts only while the host is neither stopping nor replacing the sidecar.
- R5-3: The respawn clause read as respawning even when the stop prevents the spawn, against the stop-before-spawn rule. Accepted: the clause moved to the counting claim.
- R5-4: The Korean document lacked the round-4 record and the restart-reset description sentence of item 5. Accepted: both added.

The review is closed after round 5, its last allowed round. The objections of every round are answered in the text above; the remaining details are settled by the Red/Green tests of the implementation.
