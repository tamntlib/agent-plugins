import fs from "node:fs";

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Parse a transcript JSONL file from Antigravity, Claude Code, or Codex into normalized events.
 */
function readTranscriptEvents(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return [];
  }
  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const events = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") {
      continue;
    }

    // Antigravity format: { type: "USER_INPUT" | "PLANNER_RESPONSE", step_index, content, created_at }
    if (obj.type === "USER_INPUT" && Number.isInteger(obj.step_index)) {
      events.push({
        role: "user",
        step: obj.step_index,
        content: String(obj.content || ""),
        timestamp: String(obj.created_at || ""),
      });
      continue;
    }
    if (obj.type === "PLANNER_RESPONSE") {
      events.push({
        role: "assistant",
        step: Number.isInteger(obj.step_index) ? obj.step_index : i,
        content: String(obj.content || ""),
        timestamp: String(obj.created_at || ""),
      });
      continue;
    }

    // Claude Code / Codex format: { type: "user" | "assistant", message: { role, content }, timestamp }
    const role = obj.message?.role || obj.role || obj.type;
    if (role === "user" && !obj.isMeta) {
      const textVal = extractTextContent(obj.message?.content ?? obj.content);
      if (textVal.trim()) {
        events.push({
          role: "user",
          step: i,
          content: textVal,
          timestamp: String(obj.timestamp || obj.created_at || ""),
        });
      }
    } else if (role === "assistant") {
      const textVal = extractTextContent(obj.message?.content ?? obj.content);
      if (textVal.trim()) {
        events.push({
          role: "assistant",
          step: i,
          content: textVal,
          timestamp: String(obj.timestamp || obj.created_at || ""),
        });
      }
    }
  }
  return events;
}

export function latestUserStepIndex(transcriptPath) {
  const events = readTranscriptEvents(transcriptPath);
  let latest = -1;
  for (const ev of events) {
    if (ev.role === "user" && ev.step > latest) {
      latest = ev.step;
    }
  }
  return latest;
}

/**
 * Extract completed (user, assistant) turns with user step strictly greater than `afterStep`.
 */
export function extractNewTurns(transcriptPath, afterStep = -1) {
  const events = readTranscriptEvents(transcriptPath);
  const turns = [];
  let curStep = -1;
  let curUser = "";
  let curTs = "";
  let curAssistant = "";

  const flush = () => {
    if (curStep > afterStep && curUser.trim() && curAssistant.trim()) {
      turns.push({
        step: curStep,
        user: curUser.trim(),
        assistant: curAssistant.trim(),
        timestamp: curTs,
      });
    }
    curStep = -1;
    curUser = "";
    curTs = "";
    curAssistant = "";
  };

  for (const ev of events) {
    if (ev.role === "user") {
      flush();
      curStep = ev.step;
      curUser = ev.content;
      curTs = ev.timestamp;
    } else if (ev.role === "assistant" && curStep >= 0) {
      const trimmed = ev.content.trim();
      if (trimmed) {
        curAssistant = trimmed;
      }
    }
  }
  flush();
  return turns;
}
