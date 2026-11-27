import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function pathApiFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function expandHome(inputPath, homeDir = os.homedir(), platform = process.platform) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    return "";
  }
  if (inputPath === "~") {
    return homeDir;
  }
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    const rest = inputPath.slice(2);
    const pApi = pathApiFor(platform);
    const normalizedRest =
      platform === "win32" ? rest.replace(/\//g, "\\") : rest.replace(/\\/g, "/");
    return normalizedRest ? pApi.join(homeDir, normalizedRest) : homeDir;
  }
  return inputPath;
}

/**
 * Resolve cross-platform configuration root for agent-hindsight.
 */
export function resolveConfigDir(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const fileExists =
    options.fileExists ??
    ((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
  const pApi = pathApiFor(platform);

  const explicit = (options.configDir ?? env.AGENT_HINDSIGHT_HOME ?? "").trim();
  if (explicit) {
    return expandHome(explicit, homeDir, platform);
  }

  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  if (xdg) {
    return pApi.join(expandHome(xdg, homeDir, platform), "agent-hindsight");
  }

  const dotConfig = pApi.join(homeDir, ".config", "agent-hindsight");
  if (platform === "win32") {
    if (fileExists(dotConfig)) {
      return dotConfig;
    }
    const appData = (env.APPDATA ?? "").trim();
    if (appData) {
      return pApi.join(appData, "agent-hindsight");
    }
  }
  return dotConfig;
}

/**
 * Resolve persistent per-install state directory (dedup cursors, logs, temp worker jobs).
 */
export function resolveStateDir(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const pApi = pathApiFor(platform);

  const explicit = (options.stateDir ?? env.AGENT_HINDSIGHT_STATE_DIR ?? "").trim();
  if (explicit) {
    return expandHome(explicit, homeDir, platform);
  }

  const pluginData = (env.PLUGIN_DATA ?? "").trim();
  if (pluginData) {
    return expandHome(pluginData, homeDir, platform);
  }

  return pApi.join(resolveConfigDir(options), "state");
}
