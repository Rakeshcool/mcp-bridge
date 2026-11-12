export interface UpstreamStatus {
  reachable: boolean;
  baseUrl: string;
  model: string;
  models: string[];
  error?: string;
}

function joinUrl(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

export async function upstreamProps(baseUrl: string): Promise<any> {
  const response = await fetch(joinUrl(baseUrl, "props"), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function upstreamStatus(baseUrl: string): Promise<UpstreamStatus> {
  try {
    const props = await upstreamProps(baseUrl);
    const model = String(props?.model_alias ?? props?.model_path ?? "").replace(/^\.\\/, "");
    const models: string[] = [];
    try {
      const response = await fetch(joinUrl(baseUrl, "v1/models"), { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const data: any = await response.json();
        const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
        for (const entry of list) {
          const id = String(entry?.id ?? entry?.name ?? "");
          if (id && !models.includes(id)) models.push(id);
        }
      }
    } catch {
      // A models list is optional; the chat still works without one.
    }
    return { reachable: true, baseUrl, model, models };
  } catch (error) {
    const detail = (error as Error).message;
    const friendly = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(detail)
      ? `not reachable at ${baseUrl}`
      : detail;
    return { reachable: false, baseUrl, model: "", models: [], error: friendly };
  }
}

export async function upstreamChat(baseUrl: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
  let response: Response;
  try {
    response = await fetch(joinUrl(baseUrl, "v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = (error as Error).message;
    if ((error as { name?: string })?.name === "TimeoutError" || /abort/i.test(detail)) {
      throw new Error(`UPSTREAM_TIMEOUT: llama-server did not answer within ${Math.round(timeoutMs / 1000)}s at ${baseUrl}`);
    }
    throw new Error(`UPSTREAM_UNREACHABLE: cannot reach llama-server at ${baseUrl} (${detail})`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`UPSTREAM_ERROR: llama-server returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("UPSTREAM_ERROR: llama-server returned invalid JSON");
  }
}
