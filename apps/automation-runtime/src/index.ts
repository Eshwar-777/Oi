import { createAutomationRuntimeServer } from "./server/http.js";
import { loadRuntimeConfig, runtimeConfigSummary, validateRuntimeConfig } from "./runtime/config.js";

const config = loadRuntimeConfig();
const missing = validateRuntimeConfig(config);
const server = createAutomationRuntimeServer();

server.listen(config.port, config.host, () => {
  process.stdout.write(
    JSON.stringify({
      ok: missing.length === 0,
      service: "automation-runtime",
      host: config.host,
      port: config.port,
      missing,
      summary: runtimeConfigSummary(config),
    }) + "\n",
  );
});
