"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { ChevronDown, CircleAlert, KeyRound, SendHorizontal, Square } from "lucide-react";
import { Card } from "@/components/kit";
import { Segmented, Spinner } from "@/components/ui";
import { moneyTight } from "@/components/finance/kit";
import { useFinance } from "@/components/finance/FinanceProvider";
import { buildAiContext } from "@/lib/finance-insights";
import {
  AI_PROVIDERS, DEFAULT_MODELS, PROVIDER_LABEL, askFinance, clearAiConfig, keyHint, loadAiConfig, maskKey, saveAiConfig,
  type AiConfig, type AiProvider, type ChatTurn,
} from "@/lib/finance-ai";

const TAP: CSSProperties = { height: 36, minHeight: 36 };
const KEY_NOTE = "Your key stays in this browser and requests go straight to the provider.";

type Message = { id: number; role: "user" | "assistant" | "error"; content: string };

/* ---------------------------------------------------------------- key setup */

function KeySetup({ initial, onSaved, onCancel }: { initial: AiConfig | null; onSaved: (c: AiConfig) => void; onCancel?: () => void }) {
  const [provider, setProvider] = useState<AiProvider>(initial?.provider ?? "openrouter");
  const [key, setKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? DEFAULT_MODELS[initial?.provider ?? "openrouter"]);
  const [error, setError] = useState<string | null>(null);
  const hint = keyHint(provider, key);

  const pick = (p: AiProvider) => {
    // Swap the model too unless the user typed their own.
    if (!model.trim() || model.trim() === DEFAULT_MODELS[provider]) setModel(DEFAULT_MODELS[p]);
    setProvider(p);
    setError(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // When changing only the model, an empty key field keeps the saved key for the same provider.
    const finalKey = key.trim() || (initial && initial.provider === provider ? initial.key : "");
    if (!finalKey) {
      setError("Paste your API key first.");
      return;
    }
    try {
      onSaved(saveAiConfig({ provider, key: finalKey, model }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the key.");
    }
  };

  return (
    <Card title={initial ? "Change AI key" : "Connect an AI"} description="Use your own key to ask questions about your money.">
      <form className="stack" onSubmit={submit} autoComplete="off">
        <div className="field">
          <span className="label">Provider</span>
          <Segmented block value={provider} onChange={pick} options={AI_PROVIDERS.map((p) => ({ id: p, label: PROVIDER_LABEL[p] }))} />
        </div>
        <div className="field">
          <label className="label" htmlFor="ai-key">API key</label>
          <input
            id="ai-key" className="input num" type="password" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder={initial && initial.provider === provider ? `Keep ${maskKey(initial.key)}` : provider === "openrouter" ? "sk-or-..." : provider === "anthropic" ? "sk-ant-..." : "sk-..."}
            value={key} onChange={(e) => { setKey(e.target.value); setError(null); }}
          />
          {hint && <span className="hint" style={{ color: "var(--gold-text)" }}>{hint}</span>}
        </div>
        <div className="field">
          <label className="label" htmlFor="ai-model">Model <span className="faint" style={{ fontWeight: 400 }}>Optional</span></label>
          <input id="ai-model" className="input num" autoComplete="off" autoCapitalize="off" spellCheck={false}
            placeholder={DEFAULT_MODELS[provider]} value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        {error && <div className="banner neg" role="alert"><CircleAlert /> <span>{error}</span></div>}
        <div className="row-flex" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
          {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
          <button type="submit" className="btn btn-primary"><KeyRound /> Save key</button>
        </div>
        <p className="hint" style={{ margin: 0 }}>{KEY_NOTE}</p>
      </form>
    </Card>
  );
}

/* ---------------------------------------------------------------- page */

export default function AskPage() {
  const { bundle, today, currency, demo } = useFinance();
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [showShared, setShowShared] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const chat = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(1);

  // localStorage is read after mount so server and client render the same first frame.
  useEffect(() => {
    setConfig(loadAiConfig());
    setLoaded(true);
    return () => abort.current?.abort();
  }, []);

  useEffect(() => {
    const el = chat.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const context = useMemo(() => buildAiContext(bundle, today), [bundle, today]);
  const suggestions = useMemo(() => [
    "Where is my money leaking this month?",
    `Can I afford a ${moneyTight(42_000, currency)} car payment?`,
    `When could I be debt-free if I add ${moneyTight(20_000, currency)} a month?`,
    "Is my emergency fund big enough?",
  ], [currency]);

  const resize = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy || !config) return;
    const history: ChatTurn[] = messages.filter((m): m is Message & { role: ChatTurn["role"] } => m.role !== "error").map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { id: nextId.current++, role: "user", content: q }]);
    setDraft("");
    requestAnimationFrame(resize);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const answer = await askFinance(config, context, history, q, controller.signal);
      setMessages((prev) => [...prev, { id: nextId.current++, role: "assistant", content: answer }]);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        setMessages((prev) => [...prev, { id: nextId.current++, role: "error", content: error instanceof Error ? error.message : "Something went wrong. Try again." }]);
      }
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  const remove = () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    abort.current?.abort();
    clearAiConfig();
    setConfig(null);
    setConfirmRemove(false);
    setEditing(false);
  };

  if (!loaded) {
    return <div className="row-flex faint" style={{ justifyContent: "center", padding: 32 }}><Spinner /> Loading</div>;
  }

  if (!config || editing) {
    return (
      <div style={{ maxWidth: 560, width: "100%", margin: "0 auto" }}>
        <KeySetup
          initial={config}
          onSaved={(c) => { setConfig(c); setEditing(false); }}
          onCancel={config ? () => setEditing(false) : undefined}
        />
      </div>
    );
  }

  return (
    <div className="dash-grid">
      <Card
        title="Ask your money"
        description={demo ? "Answers use the sample data." : "Answers use your private ledger."}
        action={messages.length > 0 && !busy ? <button type="button" className="btn btn-sm btn-ghost" style={TAP} onClick={() => setMessages([])}>Clear</button> : undefined}
      >
        <div className="stack">
          <div ref={chat} className="fin-chat" aria-live="polite">
            {messages.length === 0 && !busy && (
              <div style={{ margin: "auto 0", padding: "8px 0" }}>
                <div className="serif" style={{ fontSize: 22, lineHeight: 1.25 }}>What do you want to know?</div>
                <p className="muted" style={{ fontSize: 13.5, margin: "6px 0 14px" }}>Ask about spending, debt or what you can afford.</p>
                <div className="fin-chips">
                  {suggestions.map((s) => (
                    <button key={s} type="button" className="chip plain"
                      style={{ minHeight: 36, height: "auto", padding: "7px 13px", textAlign: "left", whiteSpace: "normal", lineHeight: 1.35, maxWidth: "100%" }}
                      onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) =>
              m.role === "error" ? (
                <div key={m.id} className="banner neg" role="alert" style={{ alignSelf: "flex-start", alignItems: "flex-start", maxWidth: "min(640px, 92%)", lineHeight: 1.5, overflowWrap: "anywhere" }}>
                  <CircleAlert style={{ marginTop: 2 }} /> <span>{m.content}</span>
                </div>
              ) : (
                <div key={m.id} className={`fin-msg ${m.role === "user" ? "me" : "ai"}`}>{m.content}</div>
              ),
            )}
            {busy && (
              <div className="fin-msg ai row-flex faint" style={{ gap: 8 }}><Spinner size={14} /> Thinking</div>
            )}
          </div>

          <form className="fin-composer" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
            <textarea
              ref={input} className="textarea" rows={1} value={draft} placeholder="Ask about your money"
              aria-label="Your question" enterKeyHint="send"
              onChange={(e) => { setDraft(e.target.value); resize(); }} onKeyDown={onKeyDown}
              style={{ flex: 1, minWidth: 0, fontSize: 16 }}
            />
            {busy ? (
              <button type="button" className="btn btn-icon" style={{ width: 46, height: 46 }} onClick={() => abort.current?.abort()} aria-label="Stop">
                <Square />
              </button>
            ) : (
              <button type="submit" className="btn btn-primary btn-icon" style={{ width: 46, height: 46 }} disabled={!draft.trim()} aria-label="Send">
                <SendHorizontal />
              </button>
            )}
          </form>
        </div>
      </Card>

      <div className="dash-col">
        <Card title="What gets shared" description={demo ? "Sample data, sent with each question." : "A summary of your ledger, sent with each question."}>
          <button
            type="button" className="btn btn-block" style={{ justifyContent: "space-between" }}
            aria-expanded={showShared} aria-controls="ai-shared" onClick={() => setShowShared((v) => !v)}
          >
            {showShared ? "Hide the exact text" : "Show the exact text"}
            <ChevronDown style={{ transform: showShared ? "rotate(180deg)" : undefined, transition: "transform .15s" }} />
          </button>
          {showShared && (
            <pre
              id="ai-shared"
              style={{
                margin: "12px 0 0", maxHeight: 280, overflowY: "auto", overflowX: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
                fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.55, color: "var(--ink-2)",
                background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px",
              }}
            >
              {context}
            </pre>
          )}
        </Card>

        <Card title="AI key">
          <div className="list">
            <div className="item" style={{ flexWrap: "wrap", rowGap: 10 }}>
              <div className="item-main" style={{ flex: "1 1 150px" }}>
                <div className="item-title">{PROVIDER_LABEL[config.provider]}</div>
                <div className="item-sub num" title={config.model}>{maskKey(config.key)} · {config.model}</div>
              </div>
              <div className="row-flex" style={{ gap: 6, flex: "none", marginLeft: "auto" }}>
                <button type="button" className="btn btn-sm" style={TAP} onClick={() => { setConfirmRemove(false); setEditing(true); }}>Change</button>
                <button type="button" className={`btn btn-sm ${confirmRemove ? "btn-danger" : "btn-ghost"}`} style={TAP}
                  onClick={remove} onBlur={() => setConfirmRemove(false)}>
                  {confirmRemove ? "Remove key?" : "Remove"}
                </button>
              </div>
            </div>
          </div>
          <p className="hint" style={{ margin: "10px 0 0" }}>{KEY_NOTE}</p>
        </Card>
      </div>
    </div>
  );
}
