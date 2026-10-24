// Verifies the declared command.run -> host.quit lifecycle on an already running host; it does not start or activate the application.
import { runNormalShutdown } from "./normal-shutdown-runner.mjs";

await runNormalShutdown();
