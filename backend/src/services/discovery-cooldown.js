export function createDiscoveryCooldown(log = event => console.log(JSON.stringify(event))) {
  // A short process-local cooldown avoids probing the same failing key on every request.
  const cooling = new Set();
  return async function discover(assignment, options, fetchCatalogue, read) {
    const id = String(assignment.upstream_api_key_id);
    options.signal.throwIfAborted();
    if (cooling.has(id)) return null;
    let status;
    try {
      const response = await fetchCatalogue();
      status = response.status;
      if (![408, 429, 500, 502, 503, 504].includes(status)) return read ? await read(response) : response;
      await response.body?.cancel();
    } catch (error) {
      options.signal.throwIfAborted();
      if (error.name !== 'TimeoutError' && error.message !== 'fetch failed') throw error;
    }
    if (!cooling.has(id)) {
      cooling.add(id);
      setTimeout(() => cooling.delete(id), 30000).unref();
      log({ event: 'model_discovery_cooldown', upstream_api_key_id: id, status, request_id: options.requestId });
    }
    return null;
  };
}

export function discoveryTimeout(config) {
  return Math.max(1, Math.min(5000, Math.floor((config.timeout || 300000) / 2)));
}
