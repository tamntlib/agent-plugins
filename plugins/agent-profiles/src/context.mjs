import fs from "node:fs";
import path from "node:path";

/**
 * Render the SessionStart system/context markdown injected into the agent.
 */
export function buildSessionContext(resolution, options = {}) {
  const maxContextFileChars = options.maxContextFileChars ?? 8000;
  const readFile = options.readFile ?? ((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return null;
      }
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  });

  if (!resolution.valid) {
    const lines = [
      "# Active Profile: UNRESOLVED (Fail-Closed)",
      "",
      `- Error: ${resolution.error || "Profile could not be resolved."}`,
      `- Source: \`${resolution.source}\``,
      `- Config: \`${resolution.configPath}\``,
      "- Policy: Do NOT guess a profile or fall back to another profile's credentials/accounts. Inform the user and resolve the profile configuration first.",
    ];
    if (resolution.warnings?.length) {
      lines.push("", "## Warnings");
      for (const w of resolution.warnings) {
        lines.push(`- ${w}`);
      }
    }
    return lines.join("\n");
  }

  const sections = [];
  const headerLines = [
    `# Active Profile: ${resolution.profile}`,
    "",
    `- Resolved via: \`${resolution.source}\``,
    resolution.configLoaded
      ? `- Config: \`${resolution.configPath}\``
      : `- Config: built-in defaults (create \`${resolution.configPath}\` with \`agent-profiles init\` to customize)`,
  ];

  if (resolution.description) {
    headerLines.push(`- Description: ${resolution.description}`);
  }

  const envEntries = Object.entries(resolution.env || {});
  if (envEntries.length > 0) {
    const formatted = envEntries.map(([k, v]) => `\`${k}=${v}\``).join(", ");
    headerLines.push(`- Profile env: ${formatted}`);
  }

  headerLines.push(
    `- Isolation rule: Treat \`${resolution.profile}\` as the active profile for profile-scoped skills, tools, and accounts. Never fall back to another profile if credentials or config for \`${resolution.profile}\` are missing.`
  );

  sections.push(headerLines.join("\n"));

  if (resolution.conflict) {
    const conflictLines = [
      "## Profile Conflict Warning",
      "",
      "Workspace paths in this session map to multiple profiles:",
    ];
    for (const m of resolution.conflict.matches || []) {
      conflictLines.push(`- \`${m.candidatePath}\` -> \`${m.profile}\` (\`${m.source || m.rule}\`)`);
    }
    conflictLines.push(
      "",
      `Defaulted to \`${resolution.profile}\` (\`${resolution.source}\`). Ask the user to confirm before accessing profile-scoped accounts or credentials.`
    );
    sections.push(conflictLines.join("\n"));
  }

  if (resolution.warnings?.length && !resolution.conflict) {
    const warnLines = ["## Profile Warnings", ""];
    for (const w of resolution.warnings) {
      warnLines.push(`- ${w}`);
    }
    sections.push(warnLines.join("\n"));
  }

  if (resolution.instructions && resolution.instructions.trim()) {
    sections.push(`## Profile Instructions (${resolution.profile})\n\n${resolution.instructions.trim()}`);
  }

  if (maxContextFileChars > 0 && Array.isArray(resolution.contextFiles)) {
    for (const filePath of resolution.contextFiles) {
      const raw = readFile(filePath);
      if (raw === null || raw === undefined) {
        continue;
      }
      let text = raw.trim();
      if (!text) {
        continue;
      }
      if (text.length > maxContextFileChars) {
        text = `${text.slice(0, maxContextFileChars)}\n...[truncated]`;
      }
      const label = path.basename(filePath);
      sections.push(`## Profile Context: ${label} (${resolution.profile})\n\n${text}`);
    }
  }

  return sections.join("\n\n");
}
