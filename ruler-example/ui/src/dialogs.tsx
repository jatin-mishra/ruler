// Lifecycle dialogs: approve (with sample input), reject / inactivate / reactivate (remarks), history, test, JSON view.
import { useState } from 'react';
import { api, type Kind, type VersionSummary, type VersionView } from './api';
import { readStore, useAsync, writeStore } from './hooks';
import { ApiErrorBox, Button, Icon, Modal, StatusBadge, formatTime, useToast } from './ui';

const kindLabel = (kind: Kind) => (kind === 'decision-trees' ? 'decision tree' : 'expression');

/** Runs `action`, toasts the outcome, and calls `done` on success; failures stay in the dialog. */
function useSubmit(done: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (action: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      toast('ok', ok);
      done();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

// ---------- approve ----------

export function ApproveDialog({ kind, row, onClose, onDone }: { kind: Kind; row: VersionSummary; onClose: () => void; onDone: () => void }) {
  const version = row.draft_version!;
  // The draft carries the sample its author saved (lld §17); approve checks it unless another one is given here.
  const stored = useAsync(`version|${row.key}|${version}`, () => api.get(kind, row.case_name, row.name, version));
  const [text, setText] = useState<string | null>(null);
  const [remarks, setRemarks] = useState('');
  const { busy, error, submit } = useSubmit(() => {
    onDone();
    onClose();
  });
  const original = stored.data?.sample_data == null ? '' : JSON.stringify(stored.data.sample_data, null, 2);
  const shown = text ?? original;
  const edited = text !== null && text !== original;
  let parsed: unknown;
  let parseError = '';
  try {
    parsed = shown.trim() ? JSON.parse(shown) : undefined;
  } catch (e) {
    parseError = (e as Error).message;
  }
  return (
    <Modal
      wide
      title={`Approve ${row.name} v${version}`}
      subtitle={<>Makes v{version} ACTIVE{row.active_version ? ` and v${row.active_version} INACTIVE` : ''}, in one step.</>}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !!parseError || parsed === undefined}
            onClick={() =>
              submit(
                // unchanged → let the server use the stored sample
                () => api.approve(kind, row.case_name, row.name, version, edited ? parsed : undefined, remarks || undefined),
                `${row.name} v${version} is now ACTIVE`,
              )
            }
          >
            <Icon name="shield" /> {busy ? 'Approving…' : 'Approve'}
          </Button>
        </>
      }
    >
      <ApiErrorBox error={stored.error} />
      <label className="field">
        <span className="field-label">
          Sample input {edited ? <span className="badge badge-draft">edited</span> : <span className="muted">(saved with v{version})</span>}
        </span>
        <span className="hint">
          Every attribute path the {kindLabel(kind)} uses is checked against it (presence and type). Computed attributes are not run.
        </span>
        <textarea className={`code-area ${parseError ? 'invalid' : ''}`} rows={14} spellCheck={false} value={stored.loading ? 'Loading…' : shown} onChange={(e) => setText(e.target.value)} aria-label="Sample input JSON" />
        {parseError && <span className="field-error">Invalid JSON: {parseError}</span>}
      </label>
      <label className="field">
        <span className="field-label">
          Remarks <span className="muted">(optional)</span>
        </span>
        <input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. reviewed with finance" />
      </label>
      <ApiErrorBox error={error} />
    </Modal>
  );
}

// ---------- reject / inactivate / reactivate ----------

export type RemarksAction = 'reject' | 'inactivate' | 'reactivate';

const REMARKS_COPY: Record<RemarksAction, { title: string; verb: string; required: boolean; danger: boolean; explain: string }> = {
  reject: { title: 'Reject draft', verb: 'Reject', required: true, danger: true, explain: 'The draft becomes INACTIVE and a new draft can be created. The ACTIVE version keeps serving.' },
  inactivate: { title: 'Deactivate', verb: 'Deactivate', required: false, danger: true, explain: 'The ACTIVE version becomes INACTIVE. Evaluations of this rule will fail until another version is approved.' },
  reactivate: { title: 'Reactivate', verb: 'Create draft', required: true, danger: false, explain: 'Copies this version into a new DRAFT. It still needs approval before it serves.' },
};

export function RemarksDialog({
  kind,
  row,
  action,
  version,
  onClose,
  onDone,
}: {
  kind: Kind;
  row: { case_name: string; name: string };
  action: RemarksAction;
  version?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const copy = REMARKS_COPY[action];
  const [remarks, setRemarks] = useState('');
  const { busy, error, submit } = useSubmit(() => {
    onDone();
    onClose();
  });
  const run = () => {
    const r = remarks.trim();
    if (action === 'reject') return api.reject(kind, row.case_name, row.name, version!, r);
    if (action === 'reactivate') return api.reactivate(kind, row.case_name, row.name, version!, r);
    return api.inactivate(kind, row.case_name, row.name, r || undefined);
  };
  const done = { reject: `v${version} rejected`, inactivate: `${row.name} deactivated`, reactivate: `v${version} copied into a new draft` }[action];
  return (
    <Modal
      title={`${copy.title}: ${row.name}${version ? ` v${version}` : ''}`}
      subtitle={copy.explain}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={copy.danger ? 'danger' : 'primary'} disabled={busy || (copy.required && !remarks.trim())} onClick={() => submit(run, done)}>
            {busy ? 'Working…' : copy.verb}
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">
          Remarks {copy.required ? <span className="req">*</span> : <span className="muted">(optional)</span>}
        </span>
        <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={action === 'reject' ? 'Why is it rejected?' : 'Reason for the change'} autoFocus />
      </label>
      <ApiErrorBox error={error} />
    </Modal>
  );
}

// ---------- history ----------

export function HistoryDialog({
  kind,
  row,
  onClose,
  onView,
  onReactivate,
}: {
  kind: Kind;
  row: VersionSummary;
  onClose: () => void;
  onView: (v: VersionView) => void;
  onReactivate: (version: number) => void;
}) {
  const h = useAsync(`history|${row.key}|${row.latest_version}|${row.updated_at}`, () => api.history(kind, row.case_name, row.name));
  const versions = [...(h.data?.versions ?? [])].sort((a, b) => b.version - a.version);
  const transitions = [...(h.data?.transitions ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Modal wide title={`History · ${row.name}`} subtitle={row.key} onClose={onClose}>
      <ApiErrorBox error={h.error} />
      <table className="table compact">
        <thead>
          <tr>
            <th>Version</th>
            <th>Status</th>
            <th>Created</th>
            <th>Remarks</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.version}>
              <td className="mono">v{v.version}</td>
              <td>
                <StatusBadge status={v.status} />
              </td>
              <td className="small">
                {v.created_by} · {formatTime(v.created_at)}
              </td>
              <td className="small muted">{v.remarks ?? '—'}</td>
              <td className="actions">
                <Button size="sm" variant="ghost" onClick={() => onView(v)}>
                  <Icon name="eye" /> View
                </Button>
                {v.status === 'INACTIVE' && !row.draft_version && (
                  <Button size="sm" variant="ghost" onClick={() => onReactivate(v.version)}>
                    <Icon name="refresh" /> Reactivate
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="section-title">Status changes</h3>
      <ol className="timeline">
        {transitions.map((t, i) => (
          <li key={i}>
            <span className="tl-dot" />
            <div>
              <div>
                <span className="mono">v{t.version}</span> {t.from ? <StatusBadge status={t.from} /> : <span className="muted">created</span>} →{' '}
                <StatusBadge status={t.to} />
              </div>
              <div className="small muted">
                {t.actor} · {formatTime(t.at)}
                {t.remarks ? ` · “${t.remarks}”` : ''}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Modal>
  );
}

// ---------- test (evaluate) ----------

export function TestDialog({ row, onClose }: { row: VersionSummary; onClose: () => void }) {
  const storeKey = `ruler.sample.${row.case_name}`;
  const active = useAsync(`version|${row.key}|${row.active_version}`, () => api.get('decision-trees', row.case_name, row.name, row.active_version!));
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? (active.data?.sample_data != null ? JSON.stringify(active.data.sample_data, null, 2) : readStore(storeKey) ?? '{\n  \n}');
  const setText = (t: string) => setTyped(t);
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const r = await api.evaluate(row.case_name, row.name, JSON.parse(text));
      setResult(r);
      writeStore(storeKey, text);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={`Test ${row.name}`}
      subtitle={`Evaluates the ACTIVE version (v${row.active_version}) with this input. Nothing is stored.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={busy} onClick={run}>
            <Icon name="play" /> {busy ? 'Running…' : 'Run'}
          </Button>
        </>
      }
    >
      <div className="split">
        <label className="field">
          <span className="field-label">Input</span>
          <textarea className="code-area" rows={14} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} aria-label="Input JSON" />
        </label>
        <div className="field">
          <span className="field-label">Result</span>
          {result !== undefined ? <pre className="code-area result">{JSON.stringify(result, null, 2)}</pre> : <div className="code-area empty-result">Run to see the result</div>}
        </div>
      </div>
      <ApiErrorBox error={error instanceof SyntaxError ? new Error('Input is not valid JSON: ' + error.message) : error} />
    </Modal>
  );
}

export function JsonDialog({ title, subtitle, json, onClose }: { title: string; subtitle?: string; json: unknown; onClose: () => void }) {
  return (
    <Modal wide title={title} subtitle={subtitle} onClose={onClose}>
      <pre className="code-area result">{JSON.stringify(json, null, 2)}</pre>
    </Modal>
  );
}
