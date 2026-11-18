import { useEffect, useState, type ReactNode } from "react";
import "./App.css";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  sources?: string;
}

interface CompareResult {
  question: string;
  base_gemma_answer: string;
  rag_answer: string;
  rag_sources: string;
}

type TabMode = "cti" | "compare" | "email";

function formatMarkdownLite(text: string): ReactNode[] {
  const lines = (text || "").split("\n");
  return lines.map((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("### ")) {
      return (
        <h4 key={idx} className="md-h4">
          {trimmed.slice(4)}
        </h4>
      );
    }
    if (trimmed.startsWith("## ")) {
      return (
        <h3 key={idx} className="md-h3">
          {trimmed.slice(3)}
        </h3>
      );
    }
    if (trimmed === "---") {
      return <hr key={idx} className="md-hr" />;
    }
    const parts = line.split(/(\*\*[^*]+\*\*)/g).map((part, pIdx) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={pIdx}>{part.slice(2, -2)}</strong>;
      }
      return part;
    });
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      return (
        <li key={idx} className="md-li">
          {parts}
        </li>
      );
    }
    return (
      <p key={idx} className="md-p">
        {parts}
      </p>
    );
  });
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("cti-theme") === "dark" ? "dark" : "light"
  );
  const [backendUrl, setBackendUrl] = useState<string>(
    () => localStorage.getItem("cti-backend-url") || ""
  );
  const [accessKey, setAccessKey] = useState<string>(
    () => localStorage.getItem("cti-access-key") || ""
  );
  const [connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "checking" | "connected" | "error"
  >("disconnected");
  const [statusMessage, setStatusMessage] = useState<string>(
    "Enter your Colab Cloudflare URL and Access Key, then click Connect Backend."
  );

  const [activeTab, setActiveTab] = useState<TabMode>("cti");
  const [useLiveApi, setUseLiveApi] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);

  const [ctiInput, setCtiInput] = useState<string>("");
  const [chatHistory, setChatHistory] = useState<ChatTurn[]>([]);

  const [compareInput, setCompareInput] = useState<string>("");
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);

  const [emailInput, setEmailInput] = useState<string>("");
  const [emailResult, setEmailResult] = useState<{ answer: string; sources: string } | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cti-theme", theme);
  }, [theme]);

  const cleanUrl = (raw: string) =>
    raw.replace(/[\s\u200B-\u200D\uFEFF]/g, "").replace(/\/+$/, "");

  const fetchWithRetry = async (
    url: string,
    options: RequestInit,
    retries = 1,
    timeoutMs = 15000
  ): Promise<Response> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return res;
      } catch (err) {
        clearTimeout(timer);
        if (attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error("Network request failed.");
  };

  const handleConnect = async () => {
    const normalizedUrl = cleanUrl(backendUrl);
    const normalizedKey = accessKey.trim();

    if (!normalizedUrl.startsWith("https://")) {
      setConnectionStatus("error");
      setStatusMessage("Backend URL must start with https:// (copy the trycloudflare.com link from Colab).");
      return;
    }

    setBackendUrl(normalizedUrl);
    localStorage.setItem("cti-backend-url", normalizedUrl);
    localStorage.setItem("cti-access-key", normalizedKey);

    setConnectionStatus("checking");
    setStatusMessage("Connecting to Colab FastAPI tunnel...");

    try {
      const res = await fetchWithRetry(
        `${normalizedUrl}/api/health`,
        {
          method: "GET",
          headers: { "X-Access-Key": normalizedKey },
        },
        1,
        15000
      );

      if (res.status === 401) {
        setConnectionStatus("error");
        setStatusMessage("401 Unauthorized: Access Key does not match Colab CTI_ACCESS_KEY.");
        return;
      }
      if (!res.ok) {
        setConnectionStatus("error");
        setStatusMessage(`Backend returned HTTP ${res.status}. Re-run the Colab server cell.`);
        return;
      }

      const data = await res.json();
      setConnectionStatus("connected");
      setStatusMessage(
        `Connected · Model: ${data.model} · Chunks: ${data.vector_chunks ?? 0} · CVEs: ${data.cve_records ?? 0}`
      );
    } catch (err: unknown) {
      setConnectionStatus("error");
      const isTimeout = err instanceof Error && err.name === "AbortError";
      const detail = isTimeout
        ? "Connection timed out after 15s."
        : "DNS/CORS unreachable. Wait 5 seconds and click Connect Backend again, or re-run the Colab server cell.";
      setStatusMessage(`Connection failed: ${detail}`);
    }
  };

  const handleSendCti = async (customPrompt?: string) => {
    const question = (customPrompt ?? ctiInput).trim();
    if (!question || loading) return;

    const normalizedUrl = cleanUrl(backendUrl);
    if (!normalizedUrl) {
      setStatusMessage("Please connect your Colab Backend URL first.");
      return;
    }

    const userTurn: ChatTurn = { role: "user", content: question };
    const updatedHistory = [...chatHistory, userTurn];
    setChatHistory(updatedHistory);
    setCtiInput("");
    setLoading(true);

    try {
      const res = await fetchWithRetry(
        `${normalizedUrl}/api/query`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Access-Key": accessKey.trim(),
          },
          body: JSON.stringify({
            question,
            mode: "cti",
            use_live_api: useLiveApi,
            history: updatedHistory.slice(-6).map((t) => ({
              role: t.role,
              content: t.content,
            })),
          }),
        },
        0,
        90000
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
      }

      const data = await res.json();
      setChatHistory([
        ...updatedHistory,
        {
          role: "assistant",
          content: data.answer_markdown,
          sources: data.sources_markdown,
        },
      ]);
      setConnectionStatus("connected");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setChatHistory([
        ...updatedHistory,
        {
          role: "assistant",
          content: `**Backend Error:** ${msg}. Check that your Colab runtime is still running.`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleCompare = async () => {
    const question = compareInput.trim();
    if (!question || loading) return;

    const normalizedUrl = cleanUrl(backendUrl);
    if (!normalizedUrl) {
      setStatusMessage("Please connect your Colab Backend URL first.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetchWithRetry(
        `${normalizedUrl}/api/compare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Access-Key": accessKey.trim(),
          },
          body: JSON.stringify({
            question,
            use_live_api: useLiveApi,
          }),
        },
        0,
        120000
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setCompareResult({
        question,
        base_gemma_answer: data.base_gemma_answer,
        rag_answer: data.rag_answer,
        rag_sources: data.rag_sources,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setStatusMessage(`Comparison failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleEmailTriage = async () => {
    const content = emailInput.trim();
    if (!content || loading) return;

    const normalizedUrl = cleanUrl(backendUrl);
    if (!normalizedUrl) {
      setStatusMessage("Please connect your Colab Backend URL first.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetchWithRetry(
        `${normalizedUrl}/api/query`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Access-Key": accessKey.trim(),
          },
          body: JSON.stringify({
            question: content,
            mode: "email",
            use_live_api: useLiveApi,
            history: [],
          }),
        },
        0,
        90000
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEmailResult({
        answer: data.answer_markdown,
        sources: data.sources_markdown,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setEmailResult({
        answer: `**Error:** ${msg}`,
        sources: "",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>CTI RAG Assistant</h1>
          <p className="subtitle">
            Evidence-Grounded Cyber Threat Intelligence · Base Model: Gemma 2 2B IT + Hybrid RAG
          </p>
        </div>
        <button
          className="btn-secondary"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          {theme === "light" ? "Dark Mode" : "Light Mode"}
        </button>
      </header>

      <section className="connection-card">
        <div className="connection-row">
          <div className="field-group">
            <label>Colab Cloudflare Backend URL</label>
            <input
              type="url"
              placeholder="https://your-tunnel-id.trycloudflare.com"
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
            />
          </div>
          <div className="field-group">
            <label>Access Key (CTI_ACCESS_KEY)</label>
            <input
              type="password"
              placeholder="Paste access key from Colab"
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
            />
          </div>
          <button
            className="btn-primary connect-btn"
            onClick={handleConnect}
            disabled={connectionStatus === "checking"}
          >
            {connectionStatus === "checking" ? "Connecting..." : "Connect Backend"}
          </button>
        </div>
        <div className={`status-banner status-${connectionStatus}`}>
          <span className="status-dot" />
          <span>{statusMessage}</span>
        </div>
      </section>

      <nav className="tabs">
        <button
          className={activeTab === "cti" ? "tab active" : "tab"}
          onClick={() => setActiveTab("cti")}
        >
          CTI Research & Follow-Up Chat
        </button>
        <button
          className={activeTab === "compare" ? "tab active" : "tab"}
          onClick={() => setActiveTab("compare")}
        >
          Base Gemma vs. RAG Comparison
        </button>
        <button
          className={activeTab === "email" ? "tab active" : "tab"}
          onClick={() => setActiveTab("email")}
        >
          Phishing Email Triage
        </button>
        <label className="live-toggle">
          <input
            type="checkbox"
            checked={useLiveApi}
            onChange={(e) => setUseLiveApi(e.target.checked)}
          />
          <span>Include Live ThreatCluster API</span>
        </label>
      </nav>

      {activeTab === "cti" && (
        <main className="panel">
          <div className="example-bar">
            <span>Sample Prompts:</span>
            <button
              className="chip"
              onClick={() =>
                handleSendCti(
                  "Explain what a wiper attack is in simple terms, give a real-world example scenario, and list documented mitigations."
                )
              }
            >
              Wiper Attack + Scenario
            </button>
            <button
              className="chip"
              onClick={() =>
                handleSendCti(
                  "Explain MiniDuke PDF zero-day attacks with a clear scenario and technical indicators."
                )
              }
            >
              MiniDuke Zero-Day
            </button>
            <button
              className="chip"
              onClick={() =>
                handleSendCti(
                  "How does its command-and-control (C2) communication work, and how can defenders block it?"
                )
              }
            >
              Follow-up: How does its C2 work?
            </button>
          </div>

          <div className="chat-window">
            {chatHistory.length === 0 ? (
              <div className="empty-state">
                Ask an initial CTI question above, then ask follow-up questions in the same thread (e.g.,{" "}
                <em>"Give me a simple example scenario of how this works"</em> or{" "}
                <em>"How do we mitigate it?"</em>).
              </div>
            ) : (
              chatHistory.map((turn, idx) => (
                <div key={idx} className={`chat-bubble ${turn.role}`}>
                  <div className="bubble-role">
                    {turn.role === "user" ? "SOC Analyst" : "CTI RAG Assistant (Gemma 2 2B + Hybrid Retrieval)"}
                  </div>
                  <div className="bubble-content">{formatMarkdownLite(turn.content)}</div>
                  {turn.sources && (
                    <details className="sources-box">
                      <summary>Inspect Retrieved Evidence & Dataset Citations</summary>
                      <div className="sources-body">{formatMarkdownLite(turn.sources)}</div>
                    </details>
                  )}
                </div>
              ))
            )}
            {loading && <div className="loading-indicator">Retrieving CTI records and generating grounded response...</div>}
          </div>

          <div className="composer">
            <textarea
              rows={3}
              placeholder="Ask a CTI question or follow-up question..."
              value={ctiInput}
              onChange={(e) => setCtiInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendCti();
                }
              }}
            />
            <div className="composer-actions">
              <button className="btn-secondary" onClick={() => setChatHistory([])}>
                Clear Thread
              </button>
              <button
                className="btn-primary"
                onClick={() => handleSendCti()}
                disabled={loading || !ctiInput.trim()}
              >
                {loading ? "Analyzing..." : "Send / Ask Follow-Up"}
              </button>
            </div>
          </div>
        </main>
      )}

      {activeTab === "compare" && (
        <main className="panel">
          <div className="compare-intro">
            <strong>Academic Demonstration Mode:</strong> Run the exact same query through{" "}
            <b>Raw Gemma 2 2B IT (Base Model)</b> without retrieval guardrails versus your{" "}
            <b>CTI RAG Pipeline</b> to demonstrate hallucination reduction, citation traceability, and dataset grounding.
          </div>

          <div className="example-bar">
            <span>Test Prompts:</span>
            <button
              className="chip"
              onClick={() =>
                setCompareInput("What specific PDF exploit and backdoor mechanism did MiniDuke use in our threat feed?")
              }
            >
              Niche Threat Intelligence Test
            </button>
            <button
              className="chip"
              onClick={() =>
                setCompareInput("What are the exact financial losses and MITRE techniques for CVE-2099-99999?")
              }
            >
              Fake CVE Hallucination Trap
            </button>
          </div>

          <div className="composer">
            <textarea
              rows={2}
              placeholder="Enter a CTI prompt to compare Raw Base Model vs. RAG Model side-by-side..."
              value={compareInput}
              onChange={(e) => setCompareInput(e.target.value)}
            />
            <div className="composer-actions">
              <button
                className="btn-primary"
                onClick={handleCompare}
                disabled={loading || !compareInput.trim()}
              >
                {loading ? "Running Side-by-Side Comparison..." : "Run Base vs. RAG Comparison"}
              </button>
            </div>
          </div>

          {compareResult && (
            <div className="compare-grid">
              <div className="compare-col base-col">
                <div className="col-header">
                  <span className="badge badge-warn">Base Model Only</span>
                  <h3>Raw Gemma 2 2B IT (No Retrieval)</h3>
                </div>
                <div className="col-body">{formatMarkdownLite(compareResult.base_gemma_answer)}</div>
              </div>

              <div className="compare-col rag-col">
                <div className="col-header">
                  <span className="badge badge-ok">Proposed System</span>
                  <h3>CTI RAG Model (Hybrid Search + Guardrails)</h3>
                </div>
                <div className="col-body">{formatMarkdownLite(compareResult.rag_answer)}</div>
                {compareResult.rag_sources && (
                  <details className="sources-box" open>
                    <summary>Audit Trail & Grounded Dataset Evidence</summary>
                    <div className="sources-body">{formatMarkdownLite(compareResult.rag_sources)}</div>
                  </details>
                )}
              </div>
            </div>
          )}
        </main>
      )}

      {activeTab === "email" && (
        <main className="panel">
          <div className="composer">
            <textarea
              rows={8}
              placeholder="Paste suspicious email headers, sender address, body text, and URLs here..."
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
            />
            <div className="composer-actions">
              <button
                className="btn-secondary"
                onClick={() => {
                  setEmailInput("");
                  setEmailResult(null);
                }}
              >
                Clear
              </button>
              <button
                className="btn-primary"
                onClick={handleEmailTriage}
                disabled={loading || !emailInput.trim()}
              >
                {loading ? "Inspecting Email..." : "Run Phishing Triage"}
              </button>
            </div>
          </div>

          {emailResult && (
            <div className="chat-bubble assistant">
              <div className="bubble-role">Phishing Triage Assessment</div>
              <div className="bubble-content">{formatMarkdownLite(emailResult.answer)}</div>
              {emailResult.sources && (
                <details className="sources-box" open>
                  <summary>Extracted Indicators & Domain Feed Check</summary>
                  <div className="sources-body">{formatMarkdownLite(emailResult.sources)}</div>
                </details>
              )}
            </div>
          )}
        </main>
      )}
    </div>
  );
}