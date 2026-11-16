import React, { useEffect, useState } from 'react';
import { ErrorBox, Modal } from '../components/ui';

export function UserViewingKey({ api, user, onClose }) {
  const [status, setStatus] = useState(null), [link, setLink] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const path = `/users/${user.id}/viewing-key`;
  useEffect(() => {
    let active = true;
    api(path).then(value => active && setStatus(value)).catch(e => active && setError(e.message));
    return () => { active = false; };
  }, [api, path]);
  return <Modal title={`Usage link · ${user.name}`} onClose={() => !busy && onClose()}>
    <ErrorBox error={error} />
    <p>This link shows only this user’s token consumption and usage cap. Anyone with the link can view it. It cannot change settings or make inference requests.</p>
    {user.status !== 'ACTIVE' && <p>This user is suspended. The link will work only when they are active.</p>}
    {link ? <>
      <p>Copy this link now and share it with the user. You will not be able to view it again.</p>
      <textarea className="secret" readOnly value={link} aria-label="User usage link" onFocus={e => e.target.select()} />
    </> : status ? <>
      <p>{status.exists ? 'Replacing the link immediately invalidates the old link. Anyone using it will need the new link.' : 'No usage link has been generated yet.'}</p>
      <button className="primary" disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try {
          const result = await api(path, { method: 'POST', body: {} });
          setLink(`${location.origin}${location.pathname}#user-${result.key}`);
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }}>{busy ? 'Generating…' : status.exists ? 'Replace usage link' : 'Generate usage link'}</button>
    </> : <p>{error ? 'Close and reopen to retry.' : 'Loading…'}</p>}
    <div className="form-actions"><button disabled={busy} onClick={onClose}>{link ? 'I’ve saved the link' : 'Close'}</button></div>
  </Modal>;
}
