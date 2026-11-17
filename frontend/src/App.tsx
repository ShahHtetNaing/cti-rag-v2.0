import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getHealth, normaliseUrl, runQuery, type Connection, type Health, type Mode, type QueryResult } from "./api";

const STORAGE_URL = "cti-backend-url";
const STORAGE_KEY = "cti-access-key";

const EXAMPLES: Record<Mode, string[]> = {
  cti: [
    "What do historical reports state about MiniDuke PDF zero-day attacks and its micro backdoor?",
    "What is a wiper attack and what mitigations are documented in the selected datasets?",
    "Give two documented healthcare ransomware incident cases. Include actual losses only when reported.",
    "What ransomware-group victim claims are recorded for healthcare organisations, and what does the dataset actually establish?",
  ],
  email: [
    "Subject: Urgent account suspension\nFrom: security@example-mail.com\n\nYour account will be closed today. Verify your password immediately using https://example.invalid/verify.",
  ],
};

const MODE_COPY: Record<Mode, { title: string; hint: string; placeholder: string; button: string; live: string }> = {
  cti: {
    title: "CTI research",
    hint: "Ask about threat actors, malware, vulnerabilities, incidents, targets, impacts and documented mitigations.",
    placeholder: "e.g. Give two documented healthcare ransomware cases and explain their impact and documented response.",
    button: "Analyse question",
    live: "Include live ThreatCluster API evidence (keyword search only; needs API key in Colab)",
  },
  email: {
    title: "Email triage",
    hint: "Paste the subject, sender, body and visible URLs. Remove confidential or personal information first.",
    placeholder: "Subject: ...\nFrom: ...\n\nPaste the email body and URLs here...",
    button: "Analyse email",
    live: "Send the extracted domain only to the ThreatCluster live API (email text is never sent)",
  },
};

function readInitialConnection(): Connection {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("backend");
  const keyFromUrl = params.get("key");
  if (fromUrl) localStorage.setItem(STORAGE_URL, normaliseUrl(fromUrl));
  if (keyFromUrl) localStorage.setItem(STORAGE_KEY, keyFromUrl.trim());
  if (fromUrl || keyFromUrl) {
    params.delete("backend");
    params.delete("key");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
  }
  return {
    backendUrl: localStorage.getItem(STORAGE_URL) ?? import.meta.env.VITE_DEFAULT_BACKEND_URL ?? "",
    accessKey: localStorage.getItem(STORAGE_KEY) ?? "",
  };
}

type Status = { state: "idle" | "checking" | "online" | "offline"; message?: string };

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  const [conn, setConn] = useState<Connection>(readInitialConnection);
  const [draft, setDraft] = useState<Connection>(conn);
  const [settingsOpen, setSettingsOpen] = useState(!conn.backendUrl || !conn.accessKey);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [health, setHealth] = useState<Health | null>(null);

  const [mode, setMode] = useState<Mode>("cti");
  const [inputs, setInputs] = useState<Record<Mode, string>>({ cti: "", email: "" });
  const [live, setLive] = useState<Record<Mode, boolean>>({ cti: false, email: false });
  const [results, setResults] = useState<Partial<Record<Mode, QueryResult>>>({});
  const [errors, setErrors] = useState<Partial<Record<Mode, string>>>({});
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cti-theme", theme);
  }, [theme]);

  const checkConnection = useCallback(async (target: Connection) => {
    if (!target.backendUrl) {
      setStatus({ state: "idle" });
      setHealth(null);
      return;
    }
    setStatus({ state: "checking" });
    try {
      const h = await getHealth(target);
      setHealth(h);
      setStatus({ state: "online" });
    } catch (err) {
      setHealth(null);
      setStatus({ state: "offline", message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void checkConnection(conn);
  }, [conn, checkConnection]);

  function saveConnection(e: React.FormEvent) {
    e.preventDefault();
    const next = { backendUrl: normaliseUrl(draft.backendUrl), accessKey: draft.accessKey.trim() };
    localStorage.setItem(STORAGE_URL, next.backendUrl);
    localStorage.setItem(STORAGE_KEY, next.accessKey);
    setDraft(next);
    setConn(next);
  }

  async function analyse() {
    const question = inputs[mode].trim();
    if (!question || busy) return;
    setBusy(true);
    setErrors((prev) => ({ ...prev, [mode]: undefined }));
    setElapsed(0);
    const start = performance.now();
    timerRef.current = window.setInterval(() => setElapsed((performance.now() - start) / 1000), 200);
    try {
      const result = await runQuery(conn, question, mode, live[mode]);
      setResults((prev) => ({ ...prev, [mode]: result }));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [mode]: (err as Error).message }));
      void checkConnection(conn);
    } finally {
      if (timerRef.current) window.clearInterval(timerRef.current);
      setBusy(false);
    }
  }

  function clear() {
    setInputs((prev) => ({ ...prev, [mode]: "" }));
    setResults((prev) => ({ ...prev, [mode]: undefined }));
    setErrors((prev) => ({ ...prev, [mode]: undefined }));
  }

  const copy = MODE_COPY[mode];
  const result = results[mode];
  const error = errors[mode];

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <div>
            <strong>CTI RAG Assistant</strong>
            <span>Gemma 2 2B · Chroma + BM25 hybrid retrieval</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className={`status-pill ${status.state}`}
            onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen}
            title="Backend connection settings"
          >
            <span className="dot" />
            {status.state === "online" && "Backend online"}
            {status.state === "checking" && "Connecting…"}
            {status.state === "offline" && "Backend offline"}
            {status.state === "idle" && "Connect backend"}
          </button>
          <button
            className="icon-btn"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            title="Toggle theme"
          >
            {theme === "light" ? "☾" : "☀"}
          </button>
        </div>
      </header>

      {settingsOpen && (
        <section className="card settings">
          <form onSubmit={saveConnection}>
            <div className="settings-grid">
              <label>
                <span>Backend URL</span>
                <input
                  type="url"
                  placeholder="https://xxxx.trycloudflare.com"
                  value={draft.backendUrl}
                  onChange={(e) => setDraft({ ...draft, backendUrl: e.target.value })}
                  required
                />
              </label>
              <label>
                <span>Access key</span>
                <input
                  type="password"
                  placeholder="Printed by the Colab serving cell"
                  value={draft.accessKey}
                  onChange={(e) => setDraft({ ...draft, accessKey: e.target.value })}
                  autoComplete="off"
                />
              </label>
              <button type="submit" className="btn primary">
                Save &amp; test
              </button>
            </div>
            <p className="muted small">
              Run the notebook in Google Colab (GPU runtime) up to the final “Serve the RAG pipeline” cell, then paste
              the printed URL and access key here. The Cloudflare URL changes every time the cell runs.
            </p>
            {status.state === "offline" && <p className="error small">{status.message}</p>}
          </form>
          {health && (
            <dl className="health">
              <div><dt>Model</dt><dd>{health.model}</dd></div>
              <div><dt>Vector chunks</dt><dd>{health.vector_chunks.toLocaleString()}</dd></div>
              <div><dt>CVE records</dt><dd>{health.cve_records?.toLocaleString() ?? "–"}</dd></div>
              <div><dt>Ransomware claims</dt><dd>{health.ransomware_claims?.toLocaleString() ?? "–"}</dd></div>
              <div><dt>Phishing domains</dt><dd>{health.phish_domains.toLocaleString()}</dd></div>
              <div><dt>Feed updated</dt><dd>{health.phish_feed_updated ?? "–"}</dd></div>
              <div><dt>Live API</dt><dd>{health.live_api_configured ? "Configured" : "Not configured"}</dd></div>
              <div><dt>Retrieval</dt><dd>top-k {health.top_k ?? "–"} of {health.candidate_k ?? "–"}</dd></div>
            </dl>
          )}
        </section>
      )}

      <section className="hero">
        <h1>Evidence-grounded threat intelligence</h1>
        <p>
          Research threat actors, CVEs and ransomware claims, or triage a suspicious email. Every answer is built only
          from retrieved dataset records and labelled live API results, with sources shown beside it.
        </p>
      </section>

      <main className="layout">
        <section className="card workspace">
          <div className="tabs" role="tablist">
            {(Object.keys(MODE_COPY) as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? "tab active" : "tab"}
                onClick={() => setMode(m)}
              >
                {MODE_COPY[m].title}
              </button>
            ))}
          </div>

          <p className="muted">{copy.hint}</p>
          <textarea
            value={inputs[mode]}
            onChange={(e) => setInputs((prev) => ({ ...prev, [mode]: e.target.value }))}
            placeholder={copy.placeholder}
            rows={mode === "email" ? 9 : 5}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void analyse();
            }}
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={live[mode]}
              onChange={(e) => setLive((prev) => ({ ...prev, [mode]: e.target.checked }))}
            />
            <span>{copy.live}</span>
          </label>
          <div className="actions">
            <button className="btn primary" onClick={() => void analyse()} disabled={busy || !inputs[mode].trim()}>
              {busy ? `Analysing… ${elapsed.toFixed(1)}s` : copy.button}
            </button>
            <button className="btn" onClick={clear} disabled={busy}>
              Clear
            </button>
          </div>

          <div className="examples">
            <span className="muted small">Examples</span>
            {EXAMPLES[mode].map((ex) => (
              <button key={ex} className="chip" onClick={() => setInputs((prev) => ({ ...prev, [mode]: ex }))}>
                {ex.split("\n")[0].slice(0, 90)}
                {ex.split("\n")[0].length > 90 ? "…" : ""}
              </button>
            ))}
          </div>

          {busy && (
            <div className="progress" aria-live="polite">
              <div className="bar" />
              <span className="muted small">Retrieving evidence and generating a source-bound answer with Gemma…</span>
            </div>
          )}
          {error && <div className="alert">{error}</div>}

          {result && !busy && (
            <article className="result">
              <div className="timings">
                <Metric label="Retrieval" value={result.timings.retrieval_seconds} />
                <Metric label="Generation" value={result.timings.generation_seconds} />
                <Metric label="Total" value={result.timings.total_seconds ?? result.timings.server_seconds} />
              </div>
              <div className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ExternalLink }}>
                  {result.answer_markdown}
                </ReactMarkdown>
              </div>
              <details className="sources">
                <summary>Sources, dataset citations and retrieved evidence</summary>
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ExternalLink }}>
                    {result.sources_markdown}
                  </ReactMarkdown>
                </div>
              </details>
            </article>
          )}
        </section>

        <aside className="side">
          <section className="card">
            <h3>Knowledge coverage</h3>
            <ul>
              <li>Historical CTI reports (archive)</li>
              <li>ThreatCluster incident summaries</li>
              <li>CVE exploitation signals (CVSS, KEV)</li>
              <li>Ransomware leak-site claims</li>
              <li>Curated CTI Q&amp;A</li>
              <li>PhishDestroy domain blocklist</li>
              <li>Optional live ThreatCluster API</li>
            </ul>
          </section>
          <section className="card">
            <h3>Data freshness</h3>
            <ul>
              <li>Incident, CVE and ransomware data: periodic snapshots</li>
              <li>Historical reports and Q&amp;A: archive / curated</li>
              <li>PhishDestroy: publisher states hourly updates</li>
              <li>Live API: queried at request time when enabled</li>
            </ul>
          </section>
          <section className="card notice">
            <h3>Scope boundary</h3>
            <p className="small">
              Analyst decision support only. A blocklist match is a lead and a non-match is not proof of safety. A
              ransomware listing is a group’s claim, not a confirmed breach. Missing facts are reported as “Not found in
              the selected datasets or live API results.” Verify important findings.
            </p>
          </section>
        </aside>
      </main>

      <footer className="footer muted small">
        CP5403 Assessment 2 · Pathway A: Retrieval-Augmented Generation ·{" "}
        <a href="https://github.com/ShahHtetNaing/cti-rag-v2.0" target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
      </footer>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value == null ? "–" : `${value.toFixed(2)}s`}</strong>
    </div>
  );
}

function ExternalLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} target="_blank" rel="noreferrer noopener" />;
}
