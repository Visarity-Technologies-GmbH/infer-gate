# InferGate Nginx example

[`nginx.conf.example`](nginx.conf.example) is a standalone configuration for a dedicated Linux Nginx host, serving the compiled React frontend and a backend on `127.0.0.1:3000`. It covers HTTP-to-HTTPS redirects, TLS, `/admin/*`, `/manager/*`, `/user/*`, `/v1/*`, streaming, upload limits, private APIs, operational checks and metadata-only access logging. It does not change your running Nginx configuration.

## Customize and install

1. Replace every `infergate.example.com` with your domain and set the certificate paths. Obtain the certificate first using your certificate manager; the sample does not issue or renew certificates. For HTTP-01 validation it serves `/var/www/letsencrypt/.well-known/acme-challenge/` on port 80. Provision the port-80 block separately before first issuance if the certificate does not yet exist. The enabled HSTS header requires continued HTTPS availability.
2. Set `root` to the deployed `frontend/dist` directory. Build it with `cd frontend && npm ci && npm run build`. Deploy only the compiled files there, and give the Nginx worker read access. Backend source, `.env`, diagnostic logs and other repository files must stay outside the web root.
3. Add your administrator public IP or trusted VPN CIDR above `deny all` in the `/admin` location. The default permits only loopback. The frontend shell remains public so users can open usage links; its administrator API is restricted. Set trusted monitoring addresses separately on `/health` and `/ready` if needed.
4. Adjust the worker user (`www-data` on Debian/Ubuntu, commonly `nginx` elsewhere), MIME-types include, PID, and log paths for your installation. The example assumes Nginx directly receives Internet/VPN traffic. If a load balancer precedes it, configure real-IP handling only for that trusted balancer before using the IP allowlist or rate limiter; do not trust arbitrary forwarded headers.
5. Keep the backend bound to loopback (`HOST=127.0.0.1`, `PORT=3000`), apply pending migrations with `cd backend && npm run migrate`, and start it with your process manager. Keep MySQL and Redis private. Backend administrator, proxy and viewing bearer authentication remains required.
6. For a dedicated host, install the customized sample as `/etc/nginx/nginx.conf`, preserving a copy of your existing configuration. On a shared host, merge its `http` contents into your existing `http` block and resolve existing default listeners. Do not paste `events` or `http` into a site include, and do not load this sample alongside conflicting default servers.

Validate the installed configuration and reload using your host's service manager, for example on systemd Linux:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Nginx is not installed in the development environment used to prepare this example; run `nginx -t` on your target host after substituting paths and certificates.

## API and streaming behavior

All `proxy_pass` directives intentionally omit a URI suffix, preserving complete paths such as `/admin/login`, `/manager/login`, `/user/usage` and `/v1/chat/completions`. Authorization is forwarded to InferGate, which selects the separate vendor credential for upstream calls. No CORS configuration is required because the browser uses the same HTTPS origin.

Response buffering, proxy caching, compression, request-body spooling by proxy buffering, and upstream retries are disabled for the APIs. SSE is forwarded incrementally; client disconnects close the backend connection. Request buffering being off does not remove the backend's bounded body buffering. No WebSocket/Realtime upgrade is configured because InferGate does not support it. Nginx preserves backend status codes and headers; Nginx-generated failures such as 413, 429 or 502 can still use Nginx's own error format.

The example matches the default 10 MiB inference body limit and 64 KiB administrator JSON limit. `client_body_timeout 30s` measures gaps during upload; the Node server also imposes its own 30-second HTTP request-upload timeout. `proxy_read_timeout 600s` measures gaps between backend reads, allowing time for classification/model discovery before inference begins. It does not extend the backend's default five-minute upstream timeout or impose a six-hundred-second total stream limit. Increase it if your configured multi-stage workflow can legitimately go longer without sending headers. `send_timeout 60s` disconnects clients that stop accepting response data for that interval.

The login/setup limiter uses the actual client IP at this Nginx, allows five requests per minute plus a burst of five, and shares state across its workers. Other administrator API routes are not counted. This supplements backend authentication limits; multiple Nginx hosts need a shared ingress limiter if global limits are required.

The user page is `https://YOUR_DOMAIN/#user-VIEWING_KEY`; its fragment never reaches Nginx. The page fetches `/user/usage` using an authorization header. The administrator UI uses the same root URL and its normal hashes. Unknown frontend paths return 404 because hash navigation needs no SPA path fallback.

## Logging and verification

Access logs intentionally omit query strings, request bodies, authentication headers, referrers and browser agents. API-location Nginx error logs are disabled because standard error lines may contain the full original request URI, including sensitive query strings. Use InferGate's sanitized correlation logging and the metadata access log for API diagnosis. Global Nginx startup/TLS/static-serving errors remain logged; do not switch global logging to debug or add credentials/bodies to access-log formats. Set your server's normal access-log retention policy.

After deployment, verify:

- The root loads the compiled application over HTTPS; a nonexistent frontend path returns 404.
- An administrator on an allowed address can sign in; an untrusted address receives 403 on `/admin/setup` and `/admin/login` (including uppercase variants).
- A valid viewing link shows that user's UTC tokens, estimated cost and cap; a replaced link fails. A request to `/user/usage` without a viewing key returns 401.
- An inference client can call `/v1/models` with its proxy key, and a streaming chat response arrives incrementally.
- API responses are not cached; `/health` and `/ready` are reachable only from explicitly allowed monitoring addresses.

## Directive references

- [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html): path preservation, buffering, timeouts, cancellation and retry settings.
- [Nginx core module](https://nginx.org/en/docs/http/ngx_http_core_module.html): locations, request-body limits and timeouts.
- [Nginx SSL module](https://nginx.org/en/docs/http/ngx_http_ssl_module.html): TLS configuration.
- [Nginx request-limit module](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html): per-key limiting and empty keys.
- [Nginx log module](https://nginx.org/en/docs/http/ngx_http_log_module.html): custom access-log fields.


## Manager access

Apply backend migration `018_manager_access.sql` before deploying manager access. The example exposes `/manager/*` independently of the administrator IP allowlist. Manager routes enforce their own eight-hour bearer sessions, current user/manager state, temporary-password restrictions and explicit permissions. Do not route them through the administrator allowlist unless restricting managers to that same network is intentional. Keep TLS, 64 KiB body limits, no caching and private logging rules. The shared ingress rate limiter covers `/manager/login` and `/manager/password` as well as administrator setup/login.

From an address outside the administrator allowlist, verify the root still shows **Manager sign in**, a valid manager can sign in and access the five permitted pages, and administrator-only actions return 403 through `/manager` and cannot be authorized through `/admin`. Verify temporary passwords force replacement and expire after 24 hours, and suspension, password reset and removal of manager access invalidate existing sessions. Promotion/reset/password delivery remains an administrator task; there is no email delivery service.
