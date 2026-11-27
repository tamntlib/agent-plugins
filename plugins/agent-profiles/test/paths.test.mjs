import assert from "node:assert/strict";
import test from "node:test";
import {
  expandEnvValue,
  expandHome,
  isPathWithin,
  normalizePath,
  resolveConfigLocation,
  walkAncestors,
} from "../src/paths.mjs";

test("expandHome handles ~, ~/, ~\\ on POSIX and Windows and preserves non-home strings", () => {
  assert.equal(expandHome("~", "/home/alice", "linux"), "/home/alice");
  assert.equal(expandHome("~/work/app", "/home/alice", "linux"), "/home/alice/work/app");
  assert.equal(expandHome("~\\work", "/home/alice", "linux"), "/home/alice/work");
  assert.equal(expandHome("~/work/app", "C:\\Users\\Alice", "win32"), "C:\\Users\\Alice\\work\\app");
  assert.equal(expandHome("~\\work\\app", "C:\\Users\\Alice", "win32"), "C:\\Users\\Alice\\work\\app");
  assert.equal(expandHome("~bob/work", "/home/alice", "linux"), "~bob/work");
  assert.equal(expandHome("personal", "/home/alice", "linux"), "personal");
});

test("expandEnvValue expands home-relative paths only", () => {
  assert.equal(expandEnvValue("~/.claude-work", "/home/alice", "linux"), "/home/alice/.claude-work");
  assert.equal(
    expandEnvValue("~/.claude-work", "C:\\Users\\Alice", "win32"),
    "C:\\Users\\Alice\\.claude-work"
  );
  assert.equal(expandEnvValue("work", "/home/alice", "linux"), "work");
  assert.equal(expandEnvValue("profile:work", "/home/alice", "linux"), "profile:work");
});

test("isPathWithin enforces directory boundaries on POSIX", () => {
  const opts = { platform: "linux", homeDir: "/home/alice" };
  assert.equal(isPathWithin("/home/alice/work", "~/work", opts), true);
  assert.equal(isPathWithin("/home/alice/work/repo/sub", "~/work/", opts), true);
  assert.equal(isPathWithin("/home/alice/workspace", "~/work", opts), false);
  assert.equal(isPathWithin("/home/alice/working/repo", "~/work", opts), false);
  assert.equal(isPathWithin("/var/app", "/", opts), true);
});

test("isPathWithin supports Windows drives, backslashes, and case-insensitivity", () => {
  const opts = { platform: "win32", homeDir: "C:\\Users\\Alice" };
  assert.equal(isPathWithin("c:\\users\\alice\\work\\Repo", "~/Work", opts), true);
  assert.equal(isPathWithin("C:/Users/Alice/WORK/repo", "C:\\Users\\Alice\\work", opts), true);
  assert.equal(isPathWithin("C:\\Users\\Alice\\WorkSpace", "C:\\Users\\Alice\\Work", opts), false);
  assert.equal(isPathWithin("D:\\Clients\\Acme\\App", "d:/clients/acme", opts), true);
  assert.equal(isPathWithin("D:\\Other", "C:\\", opts), false);
});

test("walkAncestors walks upward cleanly on POSIX and Windows without looping", () => {
  assert.deepEqual(
    walkAncestors("/home/alice/work/app", { platform: "linux", homeDir: "/home/alice" }),
    ["/home/alice/work/app", "/home/alice/work", "/home/alice", "/home", "/"]
  );
  assert.deepEqual(
    walkAncestors("C:\\Users\\Alice\\Work", { platform: "win32", homeDir: "C:\\Users\\Alice" }),
    ["C:\\Users\\Alice\\Work", "C:\\Users\\Alice", "C:\\Users", "C:\\"]
  );
});

test("resolveConfigLocation follows cross-platform precedence", () => {
  // Explicit file override
  const explicit = resolveConfigLocation({
    env: { AGENT_PROFILES_CONFIG: "~/custom/profiles.json" },
    platform: "linux",
    homeDir: "/home/alice",
  });
  assert.equal(explicit.configPath, "/home/alice/custom/profiles.json");
  assert.equal(explicit.source, "env:AGENT_PROFILES_CONFIG");

  // Explicit home override
  const byHome = resolveConfigLocation({
    env: { AGENT_PROFILES_HOME: "/srv/ap" },
    platform: "linux",
    homeDir: "/home/alice",
  });
  assert.equal(byHome.configPath, "/srv/ap/config.json");

  // XDG_CONFIG_HOME
  const xdg = resolveConfigLocation({
    env: { XDG_CONFIG_HOME: "/home/alice/.xdg" },
    platform: "linux",
    homeDir: "/home/alice",
  });
  assert.equal(xdg.configPath, "/home/alice/.xdg/agent-profiles/config.json");

  // Windows prefers existing ~/.config/agent-profiles/config.json if present
  const winDotConfig = resolveConfigLocation({
    env: { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
    platform: "win32",
    homeDir: "C:\\Users\\Alice",
    fileExists: (p) => p === "C:\\Users\\Alice\\.config\\agent-profiles\\config.json",
  });
  assert.equal(winDotConfig.configPath, "C:\\Users\\Alice\\.config\\agent-profiles\\config.json");
  assert.equal(winDotConfig.source, "dotconfig");

  // Windows otherwise uses %APPDATA%\agent-profiles\config.json
  const winAppData = resolveConfigLocation({
    env: { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
    platform: "win32",
    homeDir: "C:\\Users\\Alice",
    fileExists: () => false,
  });
  assert.equal(
    winAppData.configPath,
    "C:\\Users\\Alice\\AppData\\Roaming\\agent-profiles\\config.json"
  );
  assert.equal(winAppData.source, "env:APPDATA");
});

test("normalizePath strips trailing slashes except roots", () => {
  assert.equal(normalizePath("/home/alice/work///", { platform: "linux" }), "/home/alice/work");
  assert.equal(normalizePath("/", { platform: "linux" }), "/");
  assert.equal(normalizePath("C:\\Work\\", { platform: "win32" }), "C:\\Work");
  assert.equal(normalizePath("C:\\", { platform: "win32" }), "C:\\");
});
