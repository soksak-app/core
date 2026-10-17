# Document streams and memory

[한국어](document-streams-and-memory.ko.md)

## Problem

After three days of use, one browser tab measured 1.31 GB, the workbench page 242 MB (Wails) and 291 MB (Tauri), and each host about 154 MB. The tab is a document region of the browser plugin. Its host script defines part of the cost:

- On every change of the element tree it walks the whole tree of the document again, O(n) per change for n elements.
- On every change it posts the whole element list, and on every resource the whole resource list, instead of what changed.
- It produces the lists whether a consumer reads them or not, and the lists travel inside `document-state`, so every state change serializes them and sends them to the workbench page.

A native check reproduces the message volume: 50 changes of the element tree in 50 tasks produce 51 state reports, each with the full lists. Whether this volume causes the 1.31 GB is not shown yet; step 1 of the order measures it.

## Goals

- **A browser tab at the cost of the engine.** A tab of the browser plugin uses no more memory and CPU than the engine of the system needs for the page; every cost that this repository adds is measured and removed.
- **The application without growth.** The workbench page and the host keep constant object counts under repeated operations.
- **The standard mechanisms only.** Each change is a standard mechanism of the engine; no change lowers a number by removing a function or by hiding data.

## Document streams

The elements and the requests of a document become streams of their own, separate from `document-state`, collected only while a page subscribes, as an inspector collects only while it shows:

- **Subscription.** A page subscribes to the element stream or the request stream of a region and receives a handle that ends the subscription. The host counts the subscribers of each region and stream, starts collecting at the first and stops at the last. The host ties each subscription to the page that made it and removes it when that page unloads or its process ends, so a reload or a crash leaks no collection. A panel of the browser plugin subscribes while it shows. A status of the plugin that exposes a stream opens the stream in its subscribe function and closes it in its stop function; a read of it without a watch opens the stream for one snapshot and closes it, and fails with an explicit error when no snapshot arrives within its time limit.
- **Elements: snapshot under flow control.** A subscription receives one snapshot when it starts. The observer of the document only marks the tree changed. The path of a snapshot is native, then host, then the subscriber pages: native sends snapshot `seq` N to the host and sends no further snapshot until the host acknowledges N (`stream.ack {document, stream, seq}`, from host to native); the host holds one stream per region and stream, delivers the snapshot to every subscriber page and acknowledges it to native when it has delivered it, and each subscriber keeps only the latest snapshot. Changes during an unacknowledged snapshot therefore produce exactly one further snapshot, and the walk runs once per acknowledged snapshot, not once per change. A snapshot is `{seq, nodes, total, truncated}`: at most 500 elements, the number of elements of the document as `total`, and `truncated` when `total` is larger; the panel shows the truncation with the total. The walk covers the element tree of the main-frame document; shadow roots and frames are outside it, as today, and the specification says so.
- **Requests: new entries only.** The script observes resource entries with `buffered: true` and sends each batch of new entries, never the whole list again; it never clears the resource timing buffer, which the scripts of the page own. The stream keeps a log of at most 200 entries for a new subscriber and counts the entries it dropped beyond that.
- **Navigation.** A new document sends `reset` and then the snapshot or the navigation entry of the new document.
- **Small state.** `document-state` keeps `url`, `title`, `loading`, `progress`, `canGoBack`, `canGoForward`, `error`, `scroll`, `history` and `link`.

## Engine behaviors

The document regions run on WKWebView. Each of these behaviors is adopted with a measurement of the document region before and after:

- the process model: document regions of one site share a WebContent process and a website data store;
- hidden regions: a region that is not visible throttles timers, rendering and media;
- memory pressure: a region responds to the memory pressure of the system;
- caches: the back-forward cache and the memory cache of a region are bounded.

## Browser benchmark

A tracked benchmark target measures each site of a fixed list in a document region, with a page that changes its tree without pause among them, and reports per site the memory increase of the content, graphics and network processes over a baseline without the tab, the CPU at rest and in the background, the load time and the input delay, as the median and interquartile range of at least five runs. Each cost that it attributes to this repository becomes an item whose own unit test reproduces the cause (Red) and passes after the correction (Green); the benchmark is not the evidence of a correction.

## Measurement phases

The 0.0.x releases are diagnostic builds with the event log and the performance trace on, which use memory and CPU of their own. Measurement therefore runs in two phases:

1. **Record and prove.** Every measurement is taken from the event log and the performance trace of the application: the memory of each process, the object counts, the stream messages. The records are the evidence of each finding and of each Red and Green.
2. **Final verification.** The benchmarks run again with the event log and the performance trace off, through the setting `diagnostics.log` at its lowest level and the performance trace disabled, which the specification of the benchmark states. The browser benchmark and the constant counts of the application are judged on these runs only.

## Main application

The workbench page and the host are surveyed in three ways:

1. **Foundations.** The code of both hosts that creates and configures the web views and processes of a window, and where it holds memory.
2. **Improvements.** Each cause that this repository can remove by configuration or by adopting an upstream fix; an upstream defect is reported upstream with its reproduction.
3. **Our defects.** Objects of the page or the host that this repository keeps: listeners, registries, documents of earlier pages.

The counts come first: no object count of the page or the host exists yet, and the only memory value of the page is `usedJSHeapSize`, which WKWebView does not provide.

- A declared diagnostic command of both hosts returns the object counts of the host (surfaces, regions, documents, sidecar sessions, pending replies, event subscribers) and, from the page and each document, the number of elements and documents. A JavaScript heap object count is added only through an interface that the platform provides and the private API inventory records, and is stated as unavailable otherwise.
- The memory sampler of the performance trace samples the host, the page process and every document process with its window and surface.
- A tracked benchmark target starts a check configuration, records a baseline, repeats a fixed set of operations N times (open and close a tab of each kind, split and close a card, reload the plugins, open and close a project window), and records the counts and resident sizes again. Each count that grows with N is a defect with its own item: a tracked test reproduces the growth (Red), the change removes the reference that keeps the objects, and the same test shows a constant count (Green).
- The share of the performance trace in the memory of the host is measured with the trace on and off. The trace stays on in 0.0.x releases; a measured cost is reduced in the trace, not by turning it off.

## Verification

- Benchmark of the cause: a tracked target loads a page that changes a large element tree without pause into a document region and states a number: the growth of the WebContent footprint per 1000 changes with the current script and with collection off. The same site that measured 1.31 GB is measured too; if it does not reproduce the size, the cause of that size stays unproven and is recorded as such.
- Native: a document without a subscriber posts no element or request data for 50 changes in 50 tasks; with a subscriber, 50 changes during one unacknowledged snapshot produce exactly one further snapshot; the request stream sends only new entries and never clears the timing buffer; a navigation sends `reset`.
- Hosts: the subscription calls, the subscriber count, the acknowledgement to native, the removal of the subscriptions of a page that reloads or whose process ends, and their errors as contract cases of both hosts; a subscriber page that reloads without ending its subscription leaves no element post for 50 changes, and a page whose process is ended leaves a subscriber count of zero.
- Object counts: the diagnostic command and each count as a contract case of both hosts.
- plugin-api: the subscription handle ends the stream, a snapshot replaces the previous one, and the acknowledgement releases the next one.
- Browser plugin: the DOM and Network panels subscribe while they show, the statuses `browser.elements` and `browser.requests` subscribe while watched and take one snapshot on a plain read, and both render the same content as before.
- Browser level: the target of [Browser benchmark](#browser-benchmark) reports each metric per site.
- Memory: the benchmark target of the main application reports the counts per repetition.

## Order

1. The native Red of the message volume.
2. The benchmark of the cause.
3. The specification of the streams and the subscription.
4. The native streams with their checks.
5. The subscription calls of both hosts and plugin-api, and the core release that ships them.
6. The browser plugin panels and statuses on the streams, in its repository, declaring that core release; its release is a core checklist item, and the correction is unreleased until that release is published.
7. The object count command and the memory sampler of every web process.
8. The engine behaviors and the browser benchmark; one item per finding.
9. The main application survey (foundations, improvements, our defects) and its benchmark; one item per finding.
10. The trace share of the host memory.
11. The final verification with the event log and the performance trace off.

Steps 2, 8, 9 and 10 measure and produce findings; each finding is an item with its own unit Red and Green.
