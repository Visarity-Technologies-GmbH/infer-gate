export function createClient(token, onExpired = () => {}, base = "/admin") {
  return async (path, { method = "GET", body, headers = {}, signal } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      signal,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data =
      response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (
        response.status === 401 &&
        token &&
        data?.error?.code !== "invalid_credentials"
      )
        onExpired();
      const error = new Error(
        data?.error?.message ||
          `Request failed (${response.status}). Please try again.`,
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  };
}
export async function listAll(api, resource, filters = {}) {
  const rows = [];
  let after;
  do {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(filters)) {
      for (const item of Array.isArray(value) ? value : [value]) params.append(name, item);
    }
    if (after) params.set("after", after);
    const page = await api(`/${resource}${params.size ? `?${params}` : ""}`);
    rows.push(...page.data);
    after = page.next_after;
  } while (after);
  return rows;
}
export const number = (value) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
export const date = (value) => (value ? new Date(value).toLocaleString() : "—");
