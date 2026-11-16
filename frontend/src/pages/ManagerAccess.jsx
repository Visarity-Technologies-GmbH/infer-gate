import React, { useState } from 'react';
import { createClient, date } from '../api/client';
import { ErrorBox, Field, Modal } from '../components/ui';

export function ManagerLogin({ onLogin }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section className="manager-login">
    <span className="eyebrow">MANAGER ACCESS</span>
    <h2>Manager sign in</h2>
    <p>Use the email address and password assigned to your account.</p>
    <ErrorBox error={error} />
    <form onSubmit={async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      setBusy(true); setError('');
      try {
        const result = await createClient(null, undefined, '/manager')('/login', {
          method: 'POST', body: { email: data.get('email'), password: data.get('password') },
        });
        onLogin({ ...result, kind: 'manager' });
      } catch (e) { setError(e.message); } finally { setBusy(false); }
    }}>
      <Field label="Manager email" name="email" type="email" autoComplete="username" required maxLength={254} />
      <Field label="Manager password" name="password" type="password" autoComplete="current-password" required maxLength={1024} />
      <button className="primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in as manager'}</button>
    </form>
  </section>;
}

export function ManagerPassword({ api, required = false, onClose, onChanged, onLogout }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const content = <>
    <p>{required ? 'Choose a new password before opening your workspace.' : 'Changing your password signs out all your manager sessions.'}</p>
    <ErrorBox error={error} />
    <form onSubmit={async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      if (data.get('password') !== data.get('confirm')) { setError('The new passwords do not match.'); return; }
      setBusy(true); setError('');
      try {
        await api('/password', { method: 'PUT', body: { current_password: data.get('current'), password: data.get('password') } });
        onChanged('Password updated. Sign in with your new password.');
      } catch (e) { setError(e.message); } finally { setBusy(false); }
    }}>
      <Field label={required ? 'Temporary password' : 'Current password'} name="current" type="password" autoComplete="current-password" required maxLength={1024} />
      <Field label="New password" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} />
      <Field label="Confirm new password" name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} />
      <button className="primary" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>
      {required && <button type="button" disabled={busy} onClick={onLogout}>Sign out</button>}
    </form>
  </>;
  return required
    ? <div className="auth manager-password"><div className="auth-form"><span className="eyebrow">MANAGER ACCESS</span><h1>Change your temporary password</h1>{content}</div></div>
    : <Modal title="Change password" onClose={() => !busy && onClose()}>{content}</Modal>;
}

export function ManagerAccess({ api, user, onClose, onSaved }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [secret, setSecret] = useState(null);
  async function save(enabled) {
    setBusy(true); setError('');
    try {
      const result = await api(`/users/${user.id}/manager`, {
        method: 'PUT', body: { enabled, ...(enabled && user.is_manager ? { reset_password: true } : {}) },
      });
      onSaved();
      if (result) setSecret(result); else onClose();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <Modal title={`Manager access · ${user.name}`} onClose={() => !busy && onClose()}>
    <ErrorBox error={error} />
    {secret ? <>
      <p>Share this temporary password with {user.email}. It is shown only once and expires {date(secret.expires_at)}. They must change it on first sign in.</p>
      <Field label="Temporary password"><input readOnly value={secret.temporary_password} autoComplete="off" onFocus={e => e.target.select()} /></Field>
      <button onClick={onClose}>Done</button>
    </> : <>
      <p>Managers can view organizational reports and manage users, groups, proxy keys, usage caps, and usage links. Only the administrator can manage manager access.</p>
      {user.status !== 'ACTIVE' && <p>Reactivate this user before enabling manager access or resetting their password.</p>}
      <div className="form-actions">
        {Boolean(user.is_manager) && <button disabled={busy} onClick={() => save(false)}>Remove manager access</button>}
        <button className="primary" disabled={busy || user.status !== 'ACTIVE'} onClick={() => save(true)}>
          {busy ? 'Saving…' : user.is_manager ? 'Reset manager password' : 'Promote to manager'}
        </button>
      </div>
    </>}
  </Modal>;
}
