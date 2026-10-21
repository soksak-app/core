# The restart limit of persistent services

[한국어](persistent-restart.ko.md)

The proposal for F212.8a-4 and its review record. Remove this document after the rule is in [terminal runtime](../spec/terminal-runtime.md) and [sidecars](../spec/sidecars.md).

## Problem

[terminal runtime](../spec/terminal-runtime.md) states: "The restart attempts once per disconnect; a failure is reported, and the next send retries the same path." A service that dies right after each revival makes the host revive again on every disconnect: an unbounded respawn loop that needs no send and no action of the person. [sidecars](../spec/sidecars.md) `## Failure` states that its restart limit does not cover the persistent transport.

## Proposal

1. A failure of a persistent service, counted by the restart limit, is one of:
   - the service process ends while the host is not stopping its sidecars; the reader's revival counts that end when it runs for it, and it respawns the service through the single creation path, after the stale endpoint is removed or none remains, whether or not the stop below then prevents the spawn;
   - a start failure of the creation path: `the service did not print its endpoint within 30s`, `service exited before endpoint`, `the service did not answer hello within 5s`.
   A disconnect whose revival reattaches a live service is not a failure. One disconnect counts at most one failure, whatever its revival tried: a revival that retries the connect after a refusal counts as one attempt together with its retry, and a disconnect whose revival respawns the service and whose start then fails counts once, as that start failure. A start that a send initiates counts its own failure.
2. The counting follows the standard input and output rule of [sidecars](../spec/sidecars.md) `## Failure`: by the time each failure arrives, no timer, a failure more than 300 seconds before a new failure is not counted, and the fourth failure within 300 seconds stops the restarts, writes `error: sidecar <name>: restart limit: 4 failures within 300 s` and the event `host.sidecar.restart-limit` `{sidecar}` at level error.
3. The stop begins at the fourth failure, before the revival or the send runs the creation path. When the fourth failure is a failed start, the surfaces that have sent to the sidecar receive the connection notice of that failed start with its start error, as for any failed start. When it is the end of the service process, the host counts it and stops before the revival spawns, and the surfaces that have sent receive the connection notice `{"event": "connection", "connected": false, "reason": "restart limit"}`. While the service is stopped, the host runs no revival and no creation. A send fails with `sidecar <name>: restart limit`, the host writes `error: sidecar <name>: restart limit: request for <surface> refused` to its log, and the surface that sent receives its connection notice `{"event": "connection", "connected": false, "reason": "restart limit"}`. No other connection notice is written until the stop is cleared. The restart-limit reports of the persistent transport go through its connection notice only; the stop adds no `sidecar-failure` delivery.
4. Only the person's open of a surface clears the stop, as for the standard input and output transport: when the host creates a surface of a plugin whose `plugin.json` lists the sidecar in `dependencies`, it clears the failure record, writes the event `host.trace.sidecar.restart-reset` `{sidecar, surface}` at level debug, and the next send runs the creation path. A request from a surface that is already open does not clear the stop. The stop holds while the application process runs; a new application process starts with no failure record.
5. [terminal runtime](../spec/terminal-runtime.md) keeps one revival attempt per disconnect and adds this limit. In [sidecars](../spec/sidecars.md) `## Failure`, the restart-limit paragraph replaces its first sentence with one stating that the restart limit applies to a sidecar of either transport and that the failures of the persistent transport are the ones that terminal runtime names, and the later sentence that leaves the persistent limit undefined is removed. The description of `host.sidecar.restart-limit` in [events](../spec/events.json) becomes "A sidecar of either transport failed for the fourth time within 300 seconds, so the host stopped its restarts (docs/spec/sidecars.md#failure)."

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

Round 3 is open.
