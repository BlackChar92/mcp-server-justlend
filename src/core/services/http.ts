const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Execute a fetch with a default timeout to avoid indefinitely hung upstream
 * HTTP requests tying up MCP sessions.
 */
export async function fetchWithTimeout(
  input: string | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  if (!init?.signal) {
    return fetch(input, { ...init, signal: timeoutSignal });
  }

  if (typeof AbortSignal.any === "function") {
    return fetch(input, {
      ...init,
      signal: AbortSignal.any([init.signal, timeoutSignal]),
    });
  }

  return fetch(input, { ...init, signal: timeoutSignal });
}

export { DEFAULT_FETCH_TIMEOUT_MS };
