import crypto from "node:crypto";
import { clearsMinScores } from "./banks.mjs";
import {
  EXTRA_BANK_COOLDOWN_MS,
  appendHookLog,
  isExtraBankAvailable,
  markExtraBankFailed,
  markExtraBankOk,
} from "./state.mjs";

const EXTRA_BANK_TIMEOUT_SHARE = 0.8;

export function isPermanentRetainError(err) {
  const status = err?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function isAppendWithoutDocumentTextError(err) {
  return err?.status === 400 && /document text storage/i.test(String(err?.message || ""));
}

function truncateQuery(query, maxChars) {
  const raw = String(query ?? "");
  if (typeof maxChars === "number" && maxChars > 0) {
    return raw.slice(0, maxChars);
  }
  return raw;
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 7000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    };
    const resp = await fetch(url, {
      method: options.method || "POST",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    return text.trim() ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function recallSingleBank(cfg, bankId, query, { timeoutMs } = {}) {
  const url = `${cfg.apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
  const maxChars = cfg.recallMaxInputChars ?? 800;
  const body = {
    query: truncateQuery(query, maxChars),
    budget: cfg.budget,
    max_tokens: cfg.maxTokens,
  };
  if (Array.isArray(cfg.recallTags) && cfg.recallTags.length > 0) {
    body.tags = cfg.recallTags;
    body.tags_match = cfg.recallTagsMatch;
  }
  if (cfg.recallTypes?.length) {
    body.types = cfg.recallTypes;
  }
  if (cfg.recallMinScores) {
    body.min_scores = cfg.recallMinScores;
  }
  try {
    const resp = await fetchJson(url, {
      method: "POST",
      body,
      apiKey: cfg.apiKey,
      timeoutMs: timeoutMs ?? cfg.recallTimeoutMs,
    });
    let results = Array.isArray(resp?.results) ? resp.results : [];
    if (cfg.recallMinScores) {
      results = results.filter((r) => clearsMinScores(r, cfg.recallMinScores));
    }
    return { ...resp, results, notFound: false };
  } catch (err) {
    if (err.status === 404) {
      return { results: [], notFound: true };
    }
    throw err;
  }
}

export async function recallMemories(cfg, query, options = {}) {
  const stateDir = options.stateDir || null;
  const cooldownMs = options.cooldownMs ?? EXTRA_BANK_COOLDOWN_MS;
  const nowMs = options.nowMs ?? Date.now();

  const primaryBank = options.bankId || cfg.bankId;
  const rawBanks =
    Array.isArray(options.recallBanks) && options.recallBanks.length > 0
      ? options.recallBanks
      : [
          primaryBank,
          ...(cfg.additionalBanks || []),
          ...(cfg.recallAdditionalBanks || []),
        ].filter((b, idx, arr) => b && arr.indexOf(b) === idx);

  const banks = rawBanks.filter(
    (bankId, idx) => idx === 0 || isExtraBankAvailable(stateDir, "recall", bankId, nowMs)
  );

  if (banks.length === 1) {
    return recallSingleBank(cfg, banks[0], query);
  }

  const extraTimeoutMs = Math.max(
    500,
    Math.round((cfg.recallTimeoutMs ?? 7000) * EXTRA_BANK_TIMEOUT_SHARE)
  );
  const settled = await Promise.allSettled(
    banks.map((bankId, idx) =>
      recallSingleBank(cfg, bankId, query, {
        timeoutMs: idx === 0 ? cfg.recallTimeoutMs : extraTimeoutMs,
      })
    )
  );

  // Primary bank non-404 failure propagates (matching Hermes hindsight 1.2.4); extra failures cool down cleanly.
  if (settled[0].status === "rejected") {
    throw settled[0].reason;
  }

  const merged = [];
  const seen = new Set();
  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];
    const bankId = banks[i];
    const isExtra = i > 0;
    if (outcome.status !== "fulfilled") {
      if (isExtra) {
        const { newlyDown } = markExtraBankFailed(stateDir, "recall", bankId, cooldownMs, nowMs);
        if (newlyDown && stateDir) {
          appendHookLog(
            stateDir,
            `Recall extra bank ${bankId} failed (cooldown ${Math.round(cooldownMs / 1000)}s): ${outcome.reason?.message || outcome.reason}`
          );
        }
      }
      continue;
    }
    if (isExtra) {
      const { recovered } = markExtraBankOk(stateDir, "recall", bankId);
      if (recovered && stateDir) {
        appendHookLog(stateDir, `Recall extra bank ${bankId} recovered`);
      }
    }
    for (const item of outcome.value?.results || []) {
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      merged.push(item);
    }
  }
  return { results: merged };
}

export async function reflectMemory(cfg, query, options = {}) {
  const bankId = options.bankId || cfg.bankId;
  const maxChars = cfg.recallMaxInputChars ?? 800;
  const body = {
    query: truncateQuery(query, maxChars),
    budget: cfg.budget,
  };
  const tags = options.tags ?? cfg.reflectTags;
  const tagsMatch = options.tagsMatch ?? cfg.reflectTagsMatch ?? "any";
  if (Array.isArray(tags) && tags.length > 0) {
    body.tags = tags;
    body.tags_match = tagsMatch;
  }
  const url = `${cfg.apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/reflect`;
  try {
    const resp = await fetchJson(url, {
      method: "POST",
      body,
      apiKey: cfg.apiKey,
      timeoutMs: options.timeoutMs ?? Math.max(cfg.recallTimeoutMs ?? 7000, 15000),
    });
    return { ...resp, text: typeof resp?.text === "string" ? resp.text.trim() : "" };
  } catch (err) {
    if (err.status === 404) {
      return { text: "" };
    }
    throw err;
  }
}

async function postRetainToSingleBank(cfg, bankId, item, { operationId, timeoutMs } = {}) {
  const retainAsync = cfg.retainAsync !== false;
  const body = {
    items: [item],
    async: retainAsync,
  };
  if (retainAsync && operationId) {
    body.operation_id = operationId;
  }
  const url = `${cfg.apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories`;
  return fetchJson(url, {
    method: "POST",
    body,
    apiKey: cfg.apiKey,
    timeoutMs: timeoutMs ?? cfg.retainTimeoutMs,
  });
}

function resolveBankOperationId(options, bankId, isPrimary) {
  if (options.operationIds && typeof options.operationIds[bankId] === "string" && options.operationIds[bankId]) {
    return options.operationIds[bankId];
  }
  if (isPrimary && typeof options.operationId === "string" && options.operationId) {
    return options.operationId;
  }
  if (typeof options.operationId === "string" && options.operationId) {
    // Deterministic RFC-4122-shaped UUID per (operationId, bankId) so resends replay cleanly
    // without reusing one operation_id across two banks (which returns 409 on Hindsight).
    const hex = crypto
      .createHash("sha256")
      .update(`${options.operationId}:${bankId}`)
      .digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
  return null;
}

async function writeToBanks(cfg, bankIds, buildItemForBank, options = {}) {
  const stateDir = options.stateDir || null;
  const cooldownMs = options.cooldownMs ?? EXTRA_BANK_COOLDOWN_MS;
  const nowMs = options.nowMs ?? Date.now();
  const extraTimeoutMs = Math.max(
    1000,
    Math.round((cfg.retainTimeoutMs ?? 15000) * EXTRA_BANK_TIMEOUT_SHARE)
  );

  const primaryBank = bankIds[0];
  const primaryOpId = resolveBankOperationId(options, primaryBank, true);

  let primaryResp;
  try {
    primaryResp = await postRetainToSingleBank(
      cfg,
      primaryBank,
      buildItemForBank(primaryBank, { disableAppend: Boolean(options.disableAppend) }),
      { operationId: primaryOpId, timeoutMs: cfg.retainTimeoutMs }
    );
  } catch (err) {
    // Match Hermes 1.2.4 (#5599): fallback to non-append document if store_document_text is off.
    // Reuse the same operation_id because the refused append was never queued.
    if (!options.disableAppend && isAppendWithoutDocumentTextError(err)) {
      primaryResp = await postRetainToSingleBank(
        cfg,
        primaryBank,
        buildItemForBank(primaryBank, { disableAppend: true }),
        { operationId: primaryOpId, timeoutMs: cfg.retainTimeoutMs }
      );
    } else {
      throw err;
    }
  }

  for (const bankId of bankIds.slice(1)) {
    if (!isExtraBankAvailable(stateDir, "retain", bankId, nowMs)) {
      continue;
    }
    const extraOpId = resolveBankOperationId(options, bankId, false);
    try {
      await postRetainToSingleBank(
        cfg,
        bankId,
        buildItemForBank(bankId, { disableAppend: Boolean(options.disableAppend) }),
        { operationId: extraOpId, timeoutMs: extraTimeoutMs }
      );
      const { recovered } = markExtraBankOk(stateDir, "retain", bankId);
      if (recovered && stateDir) {
        appendHookLog(stateDir, `Retain extra bank ${bankId} recovered`);
      }
    } catch (err) {
      if (!options.disableAppend && isAppendWithoutDocumentTextError(err)) {
        try {
          await postRetainToSingleBank(
            cfg,
            bankId,
            buildItemForBank(bankId, { disableAppend: true }),
            { operationId: extraOpId, timeoutMs: extraTimeoutMs }
          );
          markExtraBankOk(stateDir, "retain", bankId);
          continue;
        } catch (retryErr) {
          const { newlyDown } = markExtraBankFailed(stateDir, "retain", bankId, cooldownMs, nowMs);
          if (newlyDown && stateDir) {
            appendHookLog(
              stateDir,
              `Retain extra bank ${bankId} failed (cooldown ${Math.round(cooldownMs / 1000)}s): ${retryErr.message}`
            );
          }
          continue;
        }
      }
      const { newlyDown } = markExtraBankFailed(stateDir, "retain", bankId, cooldownMs, nowMs);
      if (newlyDown && stateDir) {
        appendHookLog(
          stateDir,
          `Retain extra bank ${bankId} failed (cooldown ${Math.round(cooldownMs / 1000)}s): ${err.message}`
        );
      }
    }
  }

  return primaryResp;
}

export async function retainTurns(
  cfg,
  {
    conversationId,
    turns,
    agent = "agent",
    bankId,
    writeBanks,
    operationId,
    operationIds,
    fallbackDocumentId,
    disableAppend = false,
    stateDir,
    cooldownMs,
    nowMs,
  }
) {
  const targetBanks =
    Array.isArray(writeBanks) && writeBanks.length > 0
      ? writeBanks
      : [bankId || cfg.bankId];
  const nowIso = new Date().toISOString();
  const userPrefix = cfg.retainUserPrefix || "User";
  const assistantPrefix = cfg.retainAssistantPrefix || "Assistant";

  // Flat message array matching Hermes 1.2.4 so Hindsight chunks by turn and merges appends cleanly.
  const messages = [];
  for (const t of turns) {
    const ts = t.timestamp || nowIso;
    messages.push(
      { role: "user", content: `${userPrefix}: ${t.user}`, timestamp: ts },
      { role: "assistant", content: `${assistantPrefix}: ${t.assistant}`, timestamp: ts }
    );
  }
  const content = JSON.stringify(messages);
  const prefix = agent === "agy" ? "agy" : agent;
  const tags = [...new Set([...(cfg.retainTags || []), `session:${prefix}-${conversationId}`])];
  const context = cfg.retainContext || `conversation between ${agent} and the User`;
  const retainSource = cfg.retainSource || `${prefix}-${cfg.profile}`;
  const ownDocumentId =
    fallbackDocumentId || `${prefix}-${conversationId}-${crypto.randomBytes(6).toString("hex")}`;

  const buildItemForBank = (_targetBank, { disableAppend: noAppend }) => {
    const useAppend = !noAppend;
    // Match Hermes 1.2.4 (#6241): avoid per-call volatile metadata on append retains so
    // Hindsight does not rewrite surviving units' metadata on every turn.
    const metadata = useAppend
      ? {
          source: retainSource,
          conversation_id: String(conversationId),
        }
      : {
          source: retainSource,
          retained_at: nowIso,
          conversation_id: String(conversationId),
          message_count: String(messages.length),
        };

    const item = {
      content,
      timestamp: nowIso,
      context,
      document_id: useAppend ? `${prefix}-${conversationId}` : ownDocumentId,
      tags,
      metadata,
    };
    if (useAppend) {
      item.update_mode = "append";
    }
    if (cfg.observationScopes) {
      item.observation_scopes = cfg.observationScopes;
    }
    if (cfg.retainStrategy) {
      item.strategy = cfg.retainStrategy;
    }
    return item;
  };

  return writeToBanks(cfg, targetBanks, buildItemForBank, {
    operationId,
    operationIds,
    disableAppend,
    stateDir,
    cooldownMs,
    nowMs,
  });
}

export async function retainNote(cfg, content, context, options = {}) {
  const targetBanks =
    Array.isArray(options.writeBanks) && options.writeBanks.length > 0
      ? options.writeBanks
      : [options.bankId || cfg.bankId];
  const nowIso = new Date().toISOString();
  const effectiveContext = context || cfg.retainContext || "manual retain";

  const buildItemForBank = () => {
    const item = {
      content: String(content),
      timestamp: nowIso,
      context: effectiveContext,
      metadata: {
        source: cfg.retainSource || `agent-hindsight-${cfg.profile}`,
        retained_at: nowIso,
      },
    };
    if (Array.isArray(cfg.retainTags) && cfg.retainTags.length > 0) {
      item.tags = cfg.retainTags;
    }
    if (cfg.observationScopes) {
      item.observation_scopes = cfg.observationScopes;
    }
    if (cfg.retainStrategy) {
      item.strategy = cfg.retainStrategy;
    }
    return item;
  };

  return writeToBanks(cfg, targetBanks, buildItemForBank, {
    operationId: options.operationId || null,
    disableAppend: true,
    stateDir: options.stateDir || null,
    cooldownMs: options.cooldownMs,
    nowMs: options.nowMs,
  });
}

export async function checkHealth(cfg) {
  const url = `${cfg.apiUrl}/health`;
  return fetchJson(url, {
    method: "GET",
    apiKey: cfg.apiKey,
    timeoutMs: Math.min(cfg.recallTimeoutMs || 5000, 5000),
  });
}
