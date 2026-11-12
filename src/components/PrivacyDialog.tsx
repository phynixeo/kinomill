import { useState } from 'react';
import { Lock } from 'lucide-react';
import { Modal } from './ui';
import { call, toast } from '../lib/store';

/** Unlock private downloads, or set / change / remove the private-mode password. */
export function PrivacyDialog(props: { mode: 'unlock' | 'set'; hasPassword?: boolean; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    if (props.mode === 'unlock') {
      const r = await call('privacy.unlock', { password: pw });
      setBusy(false);
      if (r) props.onClose();
      return;
    }
    if (pw !== pw2) {
      setBusy(false);
      toast('error', 'The passwords do not match');
      return;
    }
    const r = await call('privacy.setPassword', { password: pw, current: props.hasPassword ? current : undefined });
    setBusy(false);
    if (r) {
      toast('success', pw ? 'Private mode password saved' : 'Private mode password removed');
      props.onClose();
    }
  };

  return (
    <Modal
      title={props.mode === 'unlock' ? 'Unlock private downloads' : props.hasPassword ? 'Change private mode password' : 'Set a private mode password'}
      onClose={props.onClose}
      size="narrow"
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (props.mode === 'unlock' && !pw)} onClick={submit}>
            {props.mode === 'unlock' ? 'Unlock' : 'Save'}
          </button>
        </>
      }
    >
      <form
        className="col gap-12"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="row muted small">
          <Lock size={16} />
          {props.mode === 'unlock' ? 'Enter your password to show private downloads.' : 'Private downloads are hidden from the list until you unlock them with this password.'}
        </div>
        {props.mode === 'set' && props.hasPassword && <input className="input" type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />}
        <input className="input" type="password" placeholder={props.mode === 'set' && props.hasPassword ? 'New password (empty = remove)' : 'Password'} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus={props.mode === 'unlock' || !props.hasPassword} />
        {props.mode === 'set' && <input className="input" type="password" placeholder="Repeat password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
