export type Mode = "cti" | "email";

export interface Health {
  status: string;
  model: string;
  embedding_model: string;
  top_k: number | null;
  candidate_k: number | null;
  max_new_tokens: number | null;
  vector_chunks: number;
  cve_records: number | null;
  ransomware_claims: number | null;
  phish_domains: number;
  phish_feed_status: string | null;
  phish_feed_updated: string | null;
  live_api_configured: boolean;
  server_time_utc: string;
}

export interface Timings {
  retrieval_seconds: number | null;
  generation_seconds: number | null;
  total_seconds: number | null;
  server_seconds: number;
}

export interface QueryResult {
  mode: Mode;
  answer_markdown: string;
  sources_markdown: string;
  timings: Timings;
}

export interface Connection {
  backendUrl: string;
  accessKey: string;
}

const REQUEST_TIMEOUT_MS = 180_000;

export function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

async function request<T>(conn: Connection, path: string, init?: RequestInit): Promise<T> {
  if (!conn.backendUrl) throw new Error("Set the Backend URL from your Colab notebook first.");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${normaliseUrl(conn.backendUrl)}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Access-Key": conn.accessKey,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      } catch {
        /* response was not JSON */
      }
      throw new Error(detail);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("The backend took too long to respond. Check that the Colab runtime is still running.");
    }
    if (err instanceof TypeError) {
      throw new Error("Could not reach the backend. The Colab tunnel URL may have changed or the runtime stopped.");
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

export function getHealth(conn: Connection): Promise<Health> {
  return request<Health>(conn, "/api/health");
}

export function runQuery(conn: Connection, question: string, mode: Mode, useLiveApi: boolean): Promise<QueryResult> {
  return request<QueryResult>(conn, "/api/query", {
    method: "POST",
    body: JSON.stringify({ question, mode, use_live_api: useLiveApi }),
  });
}
