// Authenticated /v1 transport shared by the runner and owner CLIs. Workflows own retries.
import { resourceIO } from "./resource-guard.ts";

export type ApiConnection = { url: string; token: string; space?: string };
export type ApiOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
};
export class ApiError extends Error {
  constructor(readonly status: number, readonly serverMessage?: string) { super(serverMessage ?? `HTTP ${status}`); this.name = "ApiError"; }
}
// Consume JSON inside the resource deadline. Never replay a request: even a failed response may follow a completed write.
export async function apiCall(connection: ApiConnection, op: string, args: any = {}, options: ApiOptions = {}): Promise<any> {
  return resourceIO(async signal => {
    const response = await (options.fetcher ?? fetch)(`${connection.url}/v1/${op}`, {
      method: "POST", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json", ...options.headers },
      body: JSON.stringify({ space: connection.space, ...args }), signal,
    });
    const body: any = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) throw new ApiError(response.status, body?.error);
    return body.result;
  }, options.timeoutMs, options.signal);
}
