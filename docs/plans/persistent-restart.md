# The restart limit of persistent services

[한국어](persistent-restart.ko.md)

The proposal for F212.8a-4 and its review record. Remove this document after the rule is in [terminal runtime](../spec/terminal-runtime.md) and [sidecars](../spec/sidecars.md).

## Problem

[terminal runtime](../spec/terminal-runtime.md) states: "The restart attempts once per disconnect; a failure is reported, and the next send retries the same path." A service that dies right after each revival makes the host revive again on every disconnect: an unbounded respawn loop that needs no send and no action of the person. [sidecars](../spec/sidecars.md) `## Failure` states that its restart limit does not cover the persistent transport.

## Proposal

1. A failure of a persistent service, counted by the restart limit, is one of:
   - the service process ends while the host is not stopping its sidecars; the revival of the reader takes the dead-service branch of the single creation path, after the stale endpoint is removed;
   - a start failure of the creation path: `the service did not print its endpoint within 30s`, `service exited before endpoint`, `the service did not answer hello within 5s`.
   A disconnect whose revival reattaches a live service is not a failure.
2. The counting follows the standard input and output rule of [sidecars](../spec/sidecars.md) `## Failure`: by the time each failure arrives, no timer, a failure more than 300 seconds before a new failure is not counted, and the fourth failure within 300 seconds stops the restarts, writes `error: sidecar <name>: restart limit: 4 failures within 300 s` and the event `host.sidecar.restart-limit` `{sidecar}` at level error.
3. While the service is stopped, the host runs no revival and no creation. A disconnect leaves the connection down and each surface that has sent to the sidecar receives its connection notice `{"event": "connection", "connected": false, "reason": "restart limit"}`. A send fails with `sidecar <name>: restart limit`. The persistent transport reports this through its connection notice only; the `sidecar-failure` event stays with the standard input and output transport.
4. Only the person's open of a surface clears the stop, as for the standard input and output transport: when the host creates a surface of a plugin whose `plugin.json` lists the sidecar in `dependencies`, it clears the failure record, writes the event `host.trace.sidecar.restart-reset` `{sidecar, surface}` at level debug, and the next send runs the creation path. A request from a surface that is already open does not clear the stop.
5. [terminal runtime](../spec/terminal-runtime.md) keeps one revival attempt per disconnect and adds this limit. [sidecars](../spec/sidecars.md) `## Failure` replaces its sentence about the undefined persistent limit with one sentence stating that the persistent transport has the same limit and that its failure events are the ones that terminal runtime names.

## Review scope

- In scope: which events count as a failure; what the stop does; the reset rule; the counting mechanics; the error and event texts; the two specification sentences.
- Out of scope: the limit values 300 s and 4 (set for both transports by F212.8a); session preservation and close semantics; the update and replacement flow; how the reader detects the end of the connection; the 30 s and 5 s start bounds.

## Review record

Round 1 is open.
