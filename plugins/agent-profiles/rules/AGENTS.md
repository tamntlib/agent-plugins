# Agent Profiles

An active profile is announced at session start (`# Active Profile: <name>`).

- Treat the announced profile as the authoritative context for profile-scoped skills, MCP tools, credentials, and accounts.
- Fail closed if the profile is reported as `UNRESOLVED` or if a `Profile Conflict Warning` is shown: ask the user to confirm before accessing any profile-scoped tool or account.
- Never silently fall back to another profile when credentials, environment variables, or configuration for the active profile are missing.
- Keep secrets (API keys, OAuth tokens, cookies, passwords) outside `agent-profiles` `config.json`; store only non-secret routing metadata and paths.
- Use the `agent-profiles` skill when the user asks to configure, inspect, switch, pin, or diagnose profiles.
