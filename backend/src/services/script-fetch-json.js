export async function fetchJson(object, apiUrl, bearerToken, signal) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(object),
    signal,
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON response from ${apiUrl}`);
  }
  if (!response.ok) {
    const message = result?.message || result?.error || 'Request failed';
    const error = new Error(message);
    error.status = response.status;
    error.response = result;
    throw error;
  }
  return result;
}
