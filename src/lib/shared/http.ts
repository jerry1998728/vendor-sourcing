/** JSON POST for client components: resolves with the parsed body, throws the server's error message on a non-2xx. */
export async function postJson<T = Record<string, unknown>>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${url} failed (${res.status})`);
  return data;
}
