# InferGate

InferGate lets teams share access to AI providers without sharing vendor credentials. Applications call one gateway with their own proxy keys. Administrators use a web dashboard to control which models each key can use, track consumption, and reduce token costs by routing simpler prompts to lower-priced models.

## Features

- **Provider access:** use OpenAI-compatible clients or the Anthropic Messages API with supported OpenAI-compatible, Anthropic, Gemini, and AWS Bedrock Mantle models. See [Claude Code setup and compatibility](backend/README.md#incoming-anthropic-messages-and-claude-code) for provider-specific limits.
- **Prompt classification and usage analysis.** Administrators can configure a role to send the system and user messages from eligible requests to a classification endpoint backed by a model such as Jev. The role’s evaluation script interprets the classifier response and labels each workload by category, sensitivity, and optional complexity. Usage reports count recorded events by category and complexity, so a team can see, for example, how often it uses AI for routine rewriting versus complex analysis. Teams can use these reports even when they keep the originally requested model.
- **Model selection and cost savings.** The evaluation script can rank candidate models for each request. For example, a role can send a short rewriting task to a model with lower per-token prices and keep the requested model for complex analysis. InferGate selects the first available candidate and enforces the role’s model policy before forwarding. When pricing is available for both models, usage reports compare the estimated cost of the recorded tokens at the requested and selected models’ rates.
- **Debug logs.** Administrators can enable **Settings → Chat completion debug logging** to inspect individual Chat Completions and Anthropic Messages requests. Logs can contain prompt and response content, the classifier exchange, and the evaluation result when those steps run. Capture is off by default and has a seven-day retention period. [Debug log details](backend/README.md#chat-completion-and-messages-debug-logs)
- **Accounting:** report tokens and estimated costs by user, model, or provider, filter by group, and set daily or weekly user caps. Pricing supports [Claude cache-write durations](backend/README.md#five-minute-and-one-hour-cache-writes).
- **Delegated access:** managers can manage users, groups, and proxy keys and view organization-wide reports. Private read-only usage links let individual users check their own consumption, estimated cost, and remaining allowance.

## How to install

The steps below run the backend and dashboard locally. You need **Node.js 24 or later** with npm. MySQL Server 8.4 is the default database; you can use the built-in SQLite mode instead. Redis is optional; the example below runs without it.

### 1. Install the prerequisites for your operating system

| Platform | Setup |
| --- | --- |
| macOS | Install Node.js 24 using the [macOS installer](https://nodejs.org/en/download). Install the [MySQL 8.4 macOS package](https://dev.mysql.com/doc/refman/8.4/en/macos-installation.html), set the root password during setup, and start MySQL from its settings pane. If the `mysql` command is unavailable, use `/usr/local/mysql/bin/mysql`. |
| Linux | Install [Node.js 24](https://nodejs.org/en/download) and follow the [MySQL 8.4 Linux instructions](https://dev.mysql.com/doc/refman/8.4/en/linux-installation.html) for your distribution. Install both the server and client. On systemd distributions, start the service with `sudo systemctl enable --now mysql` (Debian/Ubuntu) or `sudo systemctl enable --now mysqld` (RPM packages). |
| Windows | Install the [Node.js 24 Windows installer](https://nodejs.org/en/download) and the [MySQL Server 8.4 MSI](https://dev.mysql.com/doc/refman/8.4/en/windows-installation.html). Run MySQL Configurator, set a root password, and configure and start the Windows service. Use the MySQL Command Line Client for the SQL below and **Command Prompt** for the application commands. |

Open a new terminal and check `node --version` and `npm --version`. Download and extract the repository source, or clone it with Git:

```sh
git clone https://gogs.visarity.com/bastianzuehlke/infer-gate.git
cd infer-gate
```

### 2. Create the local database

For SQLite, skip the MySQL installation and SQL setup in this section. In `backend/.env`, set `DB_ENABLED=false`; SQLite will use `backend/data/infergate.sqlite` unless `SQLITE_DB_PATH` is set. Continue to the backend migration and startup steps below.

Connect as a MySQL administrator (for example, `mysql -u root -p`). Run the following SQL, replacing the password placeholder with a new password. The grant lets this local account apply InferGate migrations within its own database.

```sql
CREATE DATABASE InferGate CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'infergate'@'localhost' IDENTIFIED BY 'replace-with-a-local-password';
GRANT ALL PRIVILEGES ON InferGate.* TO 'infergate'@'localhost';
```

### 3. Configure the backend

From the repository root, run `cd backend` and `npm ci`. Create your local configuration file:

| Shell | Command |
| --- | --- |
| macOS or Linux terminal | `cp .env.example .env` |
| Windows Command Prompt | `copy .env.example .env` |

Edit `backend/.env`:

- For MySQL, leave `DB_ENABLED=true` and set `DB_USER=infergate`, `DB_NAME=InferGate`, and `DB_PASSWORD` to the password from step 2. Set `DB_PORT=3306` for a standard MySQL installation; the example file uses **3307**. Leave `DB_HOST=127.0.0.1` for a local server. For SQLite, set `DB_ENABLED=false` and skip the MySQL settings.
- Set `REDIS_ENABLED=false` unless you have configured a Redis server for caching.
- Run the following command **twice**. Use the first result for `ENCRYPTION_KEY` and the second for `BOOTSTRAP_TOKEN`. Keep the file private and preserve the encryption key: it is needed to decrypt stored provider credentials.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

### 4. Start InferGate

In the backend terminal, apply the database migrations and start the API:

```sh
npm run migrate
npm start
```

Open [the readiness endpoint](http://127.0.0.1:3000/ready) to check database connectivity. Leave the backend running. In a **second terminal**, start from the repository root:

```sh
cd frontend
npm ci
npm run dev
```

Open the [dashboard](http://127.0.0.1:5173). On first launch, enter your bootstrap token and choose an administrator password of at least 12 characters.

## Make your first request

1. In the dashboard, add a provider and an upstream API key for it. Check the key to confirm model discovery works.
2. Create a model policy allowing a model from that provider. Create an active role using the policy and assign the upstream key to it.
3. Create a user, issue a proxy key for that user, and assign the role to the proxy key. Copy the proxy key when it is shown.
4. Set your OpenAI-compatible client's base URL to `http://127.0.0.1:3000/v1` and use the **proxy key** as its API key. List models or send a chat completion using an allowed model ID.

## Deployment and documentation

For production, build the frontend with `npm run build` in `frontend/`. Follow the [Nginx deployment guide](deploy/nginx/README.md) to serve the dashboard over HTTPS, proxy API requests on the same origin, restrict administrator access, and preserve streaming. Apply pending migrations with `npm run migrate` from `backend/` before starting an updated backend.

- [Backend guide](backend/README.md): configuration, authentication, provider compatibility, pricing, reporting, and tests.
- [Dashboard guide](frontend/README.md): development, production builds, and dashboard workflows.
