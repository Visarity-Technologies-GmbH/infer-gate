import { McpTokens } from './pages/McpTokens';
import { ManagerLogin, ManagerPassword } from './pages/ManagerAccess';
import { UserUsage } from "./pages/UserUsage";
import { DebugSettings } from './pages/DebugSettings';
import { UsageMaintenanceSettings } from './pages/UsageMaintenanceSettings';
import { ClassificationHandlers } from './pages/ClassificationHandlers';
import { PricingSettings } from './pages/PricingSettings';
import { Roles } from "./pages/Roles";
import { ModelPolicies } from "./pages/ModelPolicies";
import { ModelAliases } from "./pages/ModelAliases";
import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "./api/client";
import { Icon, Field, ErrorBox } from "./components/ui";
import { Resources } from "./pages/Resources";
import { Reports } from "./pages/Reports";
import "./style.css";
const navigation = [
  ["overview", "Overview", "grid"],
  ["usage", "Usage & requests", "chart"],
  ["proxy-keys", "Proxy API keys", "key"],
  ["users", "Users", "users"],
  ["groups", "Groups", "users"],
  ["roles", "Roles", "shield"],
  ["model-policies", "Model Policies", "shield"],
  ["model-aliases", "Model Aliases", "shield"],
  ["upstream-keys", "Upstream API keys", "key"],
  ["providers", "Inference providers", "server"],
  ["classification-handlers", "Classification handlers", "server"],
  ["mcp-tokens", "MCP tokens", "key"],
  ["settings", "Settings", "settings"],
];
function Auth({ onLogin, notice }) {
  const [setup, setSetup] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    createClient()("/setup")
      .then((data) => {
        if (active) {
          setSetup(data.setup_required);
          setError("");
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [retry]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const api = createClient();
      if (setup)
        await api("/setup", {
          method: "POST",
          headers: { "x-bootstrap-token": data.get("bootstrap") },
          body: { password: data.get("password") },
        });
      const result = await api("/login", {
        method: "POST",
        body: { password: data.get("password") },
      });
      onLogin({ ...result, kind: "admin" });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth">
      <div className="auth-story">
        <Brand />
        <div>
          <span className="eyebrow">ONE GATEWAY. COMPLETE VISIBILITY.</span>
          <h1>
            Your inference.
            <br />
            Under control.
          </h1>
          <p>
            Manage access, connect providers, and understand how your
            organization uses AI.
          </p>
          <div className="orbit">
            <Icon name="shield" size={74} />
          </div>
        </div>
        <small>INFERGATE / ADMINISTRATION</small>
      </div>
      <div className="auth-form">
        <span className="eyebrow">ADMINISTRATOR ACCESS</span>
        <h1>{setup ? "Set up your gateway" : "Welcome back"}</h1>
        <p>
          {setup
            ? "Create the administrator password to get started."
            : "Sign in to your InferGate workspace."}
        </p>
        {notice && <p role="status">{notice}</p>}
        <ErrorBox error={error} />
        {setup === null ? (
          <button onClick={() => setRetry((x) => x + 1)}>
            Retry connection
          </button>
        ) : (
          <form onSubmit={submit}>
            {setup && (
              <Field
                label="Bootstrap token"
                name="bootstrap"
                type="password"
                required
                autoComplete="off"
              />
            )}
            <Field
              label="Administrator password"
              name="password"
              type="password"
              required
              minLength={setup ? 12 : 1}
              autoComplete={setup ? "new-password" : "current-password"}
            />
            {setup && <small>Use at least 12 characters.</small>}
            <button className="primary wide" disabled={busy}>
              {busy ? "Connecting…" : setup ? "Create workspace" : "Sign in"}
              <Icon name="arrow" />
            </button>
          </form>
        )}
        {setup !== true && <ManagerLogin onLogin={onLogin} />}
        <div className="auth-foot">
          <Icon name="shield" size={16} /> Secure access to your inference
          infrastructure
        </div>
      </div>
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        i<span>g</span>
      </span>
      InferGate<span className="brand-dot">.</span>
    </div>
  );
}
function Settings({ api, onLogout }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h1>Settings</h1>
          <p>Manage diagnostics, pricing, usage history, and your administrator account.</p>
        </div>
      </header>
      <DebugSettings api={api}/>
      <PricingSettings api={api}/>
      <UsageMaintenanceSettings api={api}/>
      <section className="panel settings">
        <h2>Change password</h2>
        <p>Changing your password signs out all administrator sessions.</p>
        <ErrorBox error={error} />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            if (d.get("password") !== d.get("confirm")) {
              setError("The new passwords do not match.");
              return;
            }
            setBusy(true);
            try {
              await api("/password", {
                method: "PUT",
                body: {
                  current_password: d.get("current"),
                  password: d.get("password"),
                },
              });
              onLogout("Password updated. Sign in with your new password.");
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Current password"
            name="current"
            type="password"
            autoComplete="current-password"
            required
          />
          <Field
            label="New password"
            name="password"
            type="password"
            minLength={12}
            autoComplete="new-password"
            required
          />
          <Field
            label="Confirm new password"
            name="confirm"
            type="password"
            minLength={12}
            autoComplete="new-password"
            required
          />
          <button className="primary" disabled={busy}>
            {busy ? "Updating…" : "Update password"}
          </button>
        </form>
      </section>
    </>
  );
}
function App() {
  const [session, setSession] = useState(null),
    [passwordDialog, setPasswordDialog] = useState(false),
    [notice, setNotice] = useState(""),
    [page, setPage] = useState(location.hash.slice(1) || "overview"),
    [menu, setMenu] = useState(false);
  const logout = (message) => {
    setSession(null);
    setPasswordDialog(false);
    setNotice(message || "");
  };
  const api = useMemo(
    () =>
      createClient(session?.token, () =>
        logout("Your session has expired. Please sign in again."),
        session?.kind === "manager" ? "/manager" : "/admin",
      ),
    [session],
  );
  useEffect(() => {
    const handler = () => {
      setPage(location.hash.slice(1) || "overview");
      setMenu(false);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  if (page.startsWith("user-")) return <UserUsage key={page} viewingKey={page.slice(5)} />;
  if (!session) return <Auth onLogin={setSession} notice={notice} />;
  const manager = session.kind === "manager";
  const signOut = async () => {
    try { await api("/logout", { method: "POST" }); logout(); }
    catch (e) { setNotice(e.message); }
  };
  if (manager && session.password_change_required) return <ManagerPassword api={api} required onChanged={logout} onLogout={signOut} />;
  const visibleNavigation = manager ? navigation.slice(0, 6) : navigation;
  const permittedPage = visibleNavigation.some(n => n[0] === page);
  const selected = permittedPage ? page : "overview";
  return (
    <div className="app">
      <aside className={menu ? "sidebar open" : "sidebar"}>
        <Brand />
        <div className="workspace">
          <span className="workspace-avatar">IG</span>
          <div>
            Organization workspace<small>{manager ? `Manager · ${session.user.name}` : "Administrator"}</small>
          </div>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {visibleNavigation.map(([id, label, icon], i) => (
            <React.Fragment key={id}>
              {i === 2 && (
                <span className="nav-label">ACCESS & INFRASTRUCTURE</span>
              )}
              {id === "settings" && <div className="nav-divider" />}
              <a href={`#${id}`} className={selected === id ? "active" : ""}>
                <Icon name={icon} />
                {label}
                {selected === id && <span className="active-dot" />}
              </a>
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {manager && <button onClick={() => setPasswordDialog(true)}>Change password</button>}
          <div className="gateway-note">
            <Icon name="shield" />
            <div>
              Your AI, connected.<small>One gateway. Every provider.</small>
            </div>
          </div>
          <button
            onClick={signOut}
          >
            <Icon name="logout" />
            Sign out
          </button>
          {notice && <small role="alert">{notice}</small>}
        </div>
      </aside>
      {passwordDialog && <ManagerPassword api={api} onClose={() => setPasswordDialog(false)} onChanged={logout} />}
      <div className="main">
        <div className="topbar">
          <button
            className="mobile-menu icon-button"
            onClick={() => setMenu(!menu)}
            aria-label="Toggle navigation"
          >
            <Icon name="menu" />
          </button>
          <span>
            Workspace <span className="slash">/</span>{" "}
            {navigation.find((n) => n[0] === selected)[1]}
          </span>
          <span className="admin-avatar">{manager ? "M" : "A"}</span>
        </div>
        <main>
          {!permittedPage && manager && <p role="status">This page requires administrator access. Showing Overview.</p>}
          {selected === "overview" || selected === "usage" ? (
            <Reports key={selected} mode={selected} api={api} />
          ) : selected === "mcp-tokens" ? (
            <McpTokens api={api} manager={manager} />
          ) : selected === "roles" ? (
            <Roles api={api} />
          ) : selected === "model-policies" ? (
            <ModelPolicies api={api} />
          ) : selected === "model-aliases" ? (
            <ModelAliases api={api} />
          ) : selected === "classification-handlers" ? (
            <ClassificationHandlers api={api} />
          ) : selected === "settings" ? (
            <Settings api={api} onLogout={logout} />
          ) : (
            <Resources key={selected} resource={selected} api={api} isAdmin={!manager} />
          )}
        </main>
        <footer>
          InferGate <span>OpenAI-compatible inference gateway</span>
        </footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
