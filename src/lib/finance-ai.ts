/**
 * Bring-your-own-key AI for SPLITTER Finance (ported from Folio's Ask view).
 * The key lives in this browser's localStorage only and requests go straight from the
 * browser to the provider. Nothing here touches SPLITTER's server or database.
 * Pure parts (buildRequest, parseResponse, maskKey, keyHint) are covered by tests/finance-ai.test.ts.
 */
import { AI_SYSTEM_PROMPT } from "./finance-insights.ts";

export type AiProvider = "openrouter" | "openai" | "anthropic";
export type AiConfig = { provider: AiProvider; key: string; model: string };
export type ChatTurn = { role: "user" | "assistant"; content: string };

export const AI_PROVIDERS: readonly AiProvider[] = ["openrouter", "openai", "anthropic"];
export const PROVIDER_LABEL: Record<AiProvider, string> = { openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic" };
export const DEFAULT_MODELS: Record<AiProvider, string> = {
  openrouter: "openai/gpt-4.1-mini",
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-5",
};
export const AI_ENDPOINTS: Record<AiProvider, string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};
/** Earlier turns sent along with each new question. */
export const HISTORY_TURNS = 8;
export const ANTHROPIC_MAX_TOKENS = 900;
export const AI_STORAGE_KEY = "splitter-finance-ai";

export function isProvider(v: unknown): v is AiProvider {
  return typeof v === "string" && (AI_PROVIDERS as readonly string[]).includes(v);
}

/* ---------------------------------------------------------------- storage (per device) */

function storage(): Storage | null {
  try {
    // Check window first: Node exposes an experimental localStorage that warns on access.
    if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function normalizeConfig(input: { provider: unknown; key: unknown; model?: unknown }): AiConfig | null {
  if (!isProvider(input.provider)) return null;
  const key = typeof input.key === "string" ? input.key.trim() : "";
  if (!key) return null;
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : DEFAULT_MODELS[input.provider];
  return { provider: input.provider, key, model };
}

export function loadAiConfig(): AiConfig | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(AI_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    return parsed && typeof parsed === "object" ? normalizeConfig({ provider: parsed.provider, key: parsed.key, model: parsed.model }) : null;
  } catch {
    return null;
  }
}

/** Returns the stored config, or throws when the browser blocks storage. */
export function saveAiConfig(config: AiConfig): AiConfig {
  const clean = normalizeConfig(config);
  if (!clean) throw new Error("Paste an API key first.");
  const s = storage();
  if (!s) throw new Error("This browser is blocking local storage, so the key can't be saved.");
  try {
    s.setItem(AI_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    throw new Error("This browser is blocking local storage, so the key can't be saved.");
  }
  return clean;
}

export function clearAiConfig(): void {
  try {
    storage()?.removeItem(AI_STORAGE_KEY);
  } catch {
    /* storage blocked */
  }
}

/* ---------------------------------------------------------------- display helpers */

/** "sk-o…9f3a". Short keys are fully hidden so masking never reveals most of the key. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length < 12) return "••••••••";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** Soft warning when a pasted key looks like it belongs to another provider. Null when fine. */
export function keyHint(provider: AiProvider, key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  if (provider === "openrouter" && !k.startsWith("sk-or-")) {
    return k.startsWith("sk-ant-") ? "That looks like an Anthropic key." : "OpenRouter keys usually start with sk-or-.";
  }
  if (provider === "anthropic" && !k.startsWith("sk-ant-")) {
    return k.startsWith("sk-or-") ? "That looks like an OpenRouter key." : "Anthropic keys usually start with sk-ant-.";
  }
  if (provider === "openai") {
    if (k.startsWith("sk-or-")) return "That looks like an OpenRouter key.";
    if (k.startsWith("sk-ant-")) return "That looks like an Anthropic key.";
    if (!k.startsWith("sk-")) return "OpenAI keys usually start with sk-.";
  }
  return null;
}

/* ---------------------------------------------------------------- requests (pure) */

export function systemPrompt(context: string): string {
  return `${AI_SYSTEM_PROMPT}\n\nLedger:\n${context}`;
}

/**
 * Keeps the newest message plus the HISTORY_TURNS before it, drops blanks, merges
 * back-to-back turns from the same role (e.g. a question whose answer failed) and
 * makes sure the conversation starts with the user, which Anthropic requires.
 */
export function prepareMessages(messages: readonly ChatTurn[]): ChatTurn[] {
  const kept = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-(HISTORY_TURNS + 1));
  const merged: ChatTurn[] = [];
  for (const m of kept) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content.trim()}`;
    else merged.push({ role: m.role, content: m.content.trim() });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  return merged;
}

export function buildRequest(config: AiConfig, system: string, messages: readonly ChatTurn[]): { url: string; init: RequestInit } {
  const key = config.key.trim();
  const model = config.model.trim() || DEFAULT_MODELS[config.provider];
  const turns = prepareMessages(messages);
  if (!key) throw new Error("Add an API key first.");
  if (!turns.length) throw new Error("Ask a question first.");

  if (config.provider === "anthropic") {
    return {
      url: AI_ENDPOINTS.anthropic,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model, max_tokens: ANTHROPIC_MAX_TOKENS, system, messages: turns }),
      },
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  if (config.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://usesplitter.vercel.app";
    headers["X-Title"] = "SPLITTER";
  }
  return {
    url: AI_ENDPOINTS[config.provider],
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...turns] }),
    },
  };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Provider error text from any of the common payload shapes, or null. */
export function providerError(json: unknown): string | null {
  if (!isObj(json)) return null;
  const e = json.error;
  if (typeof e === "string" && e.trim()) return e.trim();
  if (isObj(e) && typeof e.message === "string" && e.message.trim()) return e.message.trim();
  if (json.type === "error" && typeof json.message === "string") return json.message;
  return null;
}

function textFromParts(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p === "string" ? p : isObj(p) && (p.type === undefined || p.type === "text") && typeof p.text === "string" ? p.text : ""))
    .join("");
}

/** Answer text, or throws with the provider's own error message. */
export function parseResponse(provider: AiProvider, json: unknown): string {
  const name = PROVIDER_LABEL[provider];
  const err = providerError(json);
  if (err) throw new Error(`${name}: ${err}`);
  if (!isObj(json)) throw new Error(`${name} sent a response SPLITTER couldn't read.`);

  let text = "";
  if (provider === "anthropic") {
    text = textFromParts(json.content);
  } else {
    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    if (isObj(choice)) {
      const choiceErr = providerError(choice);
      if (choiceErr) throw new Error(`${name}: ${choiceErr}`);
      text = isObj(choice.message) ? textFromParts(choice.message.content) : "";
      if (!text.trim() && isObj(choice.message) && typeof choice.message.refusal === "string") text = choice.message.refusal;
    }
  }
  text = text.trim();
  if (!text) throw new Error(`${name} returned an empty answer. Try asking again.`);
  return text;
}

function statusMessage(provider: AiProvider, status: number): string {
  const name = PROVIDER_LABEL[provider];
  if (status === 401 || status === 403) return `${name} didn't accept this key. Check it or paste a new one.`;
  if (status === 402) return `${name} says this account is out of credits.`;
  if (status === 404) return `${name} couldn't find that model. Check the model name.`;
  if (status === 429) return `${name} is rate limiting this key. Wait a moment and try again.`;
  if (status >= 500) return `${name} is having trouble right now. Try again in a minute.`;
  return `${name} returned an error (${status}).`;
}

/* ---------------------------------------------------------------- network */

export async function askFinance(
  config: AiConfig,
  context: string,
  history: readonly ChatTurn[],
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  const q = question.trim();
  if (!q) throw new Error("Ask a question first.");
  const { url, init } = buildRequest(config, systemPrompt(context), [...history, { role: "user", content: q }]);

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error(`Couldn't reach ${PROVIDER_LABEL[config.provider]}. Check your connection and try again.`);
  }
  const raw = await res.text();
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = providerError(json);
    if (res.status === 401 || res.status === 403 || !err) throw new Error(err ? `${statusMessage(config.provider, res.status)} (${err})` : statusMessage(config.provider, res.status));
    throw new Error(`${PROVIDER_LABEL[config.provider]}: ${err}`);
  }
  return parseResponse(config.provider, json);
}
