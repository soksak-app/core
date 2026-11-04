// The start of the floor page view. A view surface is placed once it declares its composition (docs/spec/native-surfaces.md#view-surfaces,
// surface phase), so the page declares a composition without regions through the view bridge and runs nothing else.
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
await bridge.composition.create();
