import type { RuntimeConfig } from "./config.js";

export function ensurePluginAllowlisted(cfg: RuntimeConfig, pluginId: string): RuntimeConfig {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.includes(pluginId)) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId],
    },
  };
}
