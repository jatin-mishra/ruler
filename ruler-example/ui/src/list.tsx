// Home: every decision tree and expression of a case, with its lifecycle actions.
import { useState } from 'react';
import { api, typeLabel, type Kind, type VersionSummary, type VersionView } from './api';
import { ApproveDialog, HistoryDialog, JsonDialog, RemarksDialog, TestDialog, type RemarksAction } from './dialogs';
import { useAsync } from './hooks';
import { ApiErrorBox, Button, Icon, StatusBadge, formatTime } from './ui';

type Dialog =
  | { type: 'approve'; row: VersionSummary }
  | { type: 'remarks'; row: VersionSummary; action: RemarksAction; version?: number }
  | { type: 'history'; row: VersionSummary }
  | { type: 'test'; row: VersionSummary }
  | { type: 'json'; view: VersionView };

export function ListPage({
  caseName,
  tab,
  go,
  withActor,
}: {
  caseName: string;
  tab: Kind;
  go: (hash: string) => void;
  withActor: (fn: () => void) => void;
}) {
  const trees = useAsync(`list|trees|${caseName}`, () => api.list('decision-trees', caseName));
  const exprs = useAsync(`list|exprs|${caseName}`, () => api.list('expressions', caseName));
  const current = tab === 'decision-trees' ? trees : exprs;
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const reload = () => current.reload();
  const isTree = tab === 'decision-trees';

  const rows = (current.data ?? []).filter((r) => `${r.name} ${r.description ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const setTab = (k: Kind) => go(`/?case=${encodeURIComponent(caseName)}&tab=${k}`);
  const route = isTree ? 'tree' : 'expr';
  const newHash = isTree ? `/new?case=${encodeURIComponent(caseName)}` : `/expr/new?case=${encodeURIComponent(caseName)}`;
  const open = (r: VersionSummary, mode: 'view' | 'edit', version?: number) =>
    go(`/${route}/${encodeURIComponent(r.case_name)}/${encodeURIComponent(r.name)}?mode=${mode}${version ? `&version=${version}` : ''}`);
  const view = (r: VersionSummary, version?: number) => open(r, 'view', version);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Rules</h1>
          <p className="muted">Decision trees and expressions for this case. Every change is a new version that needs approval.</p>
        </div>
        <Button variant="primary" onClick={() => go(newHash)}>
          <Icon name="plus" /> {isTree ? 'New decision tree' : 'New expression'}
        </Button>
      </div>

      <div className="toolbar">
        <div className="tabs" role="tablist">
          {(
            [
              ['decision-trees', 'Decision trees', trees.data?.length],
              ['expressions', 'Expressions', exprs.data?.length],
            ] as const
          ).map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {label}
              {n !== undefined && <span className="count">{n}</span>}
            </button>
          ))}
        </div>
        <input className="search" placeholder="Search by name or description" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
      </div>

      <ApiErrorBox error={current.error} />

      {current.loading && !current.data ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">
            <Icon name="tree" size={28} />
          </div>
          <div className="empty-title">{query ? 'Nothing matches your search' : `No ${isTree ? 'decision trees' : 'expressions'} yet`}</div>
          {!query && (
            <Button variant="primary" onClick={() => go(newHash)}>
              <Icon name="plus" /> Create the first one
            </Button>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Returns</th>
                <th>Last change</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <button className="name-link" onClick={() => view(r)}>
                      {r.name}
                    </button>
                    {r.description && <div className="small muted clamp">{r.description}</div>}
                  </td>
                  <td>
                    <div className="badges">
                      {r.active_version && <StatusBadge status="ACTIVE" version={r.active_version} />}
                      {r.draft_version && <StatusBadge status="DRAFT" version={r.draft_version} />}
                      {!r.active_version && !r.draft_version && <StatusBadge status="INACTIVE" version={r.latest_version} />}
                    </div>
                  </td>
                  <td>
                    <span className="type-chip">{typeLabel(r.return_type)}</span>
                  </td>
                  <td className="small nowrap">
                    {r.updated_by}
                    <div className="muted">{formatTime(r.updated_at)}</div>
                  </td>
                  <td>
                    {/* one clear next step per row; the rest are icon buttons with tooltips */}
                    <div className="row-actions">
                      {r.draft_version ? (
                        <>
                          <Button size="sm" variant="primary" onClick={() => withActor(() => setDialog({ type: 'approve', row: r }))}>
                            <Icon name="shield" /> Approve v{r.draft_version}
                          </Button>
                          <Button size="sm" onClick={() => withActor(() => setDialog({ type: 'remarks', row: r, action: 'reject', version: r.draft_version! }))}>
                            Reject
                          </Button>
                          <span className="sep" />
                        </>
                      ) : (
                        <Button size="sm" onClick={() => open(r, 'edit')}>
                          <Icon name="edit" /> Edit
                        </Button>
                      )}
                      <button className="icon-btn" title={r.draft_version ? `View draft v${r.draft_version}` : 'View'} aria-label="View" onClick={() => view(r, r.draft_version ?? undefined)}>
                        <Icon name="eye" />
                      </button>
                      {isTree && r.active_version && (
                        <button className="icon-btn" title="Test with an input" aria-label="Test" onClick={() => setDialog({ type: 'test', row: r })}>
                          <Icon name="play" />
                        </button>
                      )}
                      <button className="icon-btn" title="History" aria-label="History" onClick={() => setDialog({ type: 'history', row: r })}>
                        <Icon name="history" />
                      </button>
                      {r.active_version && (
                        <button className="icon-btn danger" title="Deactivate" aria-label="Deactivate" onClick={() => withActor(() => setDialog({ type: 'remarks', row: r, action: 'inactivate' }))}>
                          <Icon name="ban" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.type === 'approve' && <ApproveDialog kind={tab} row={dialog.row} onClose={close} onDone={reload} />}
      {dialog?.type === 'remarks' && <RemarksDialog kind={tab} row={dialog.row} action={dialog.action} version={dialog.version} onClose={close} onDone={reload} />}
      {dialog?.type === 'test' && <TestDialog row={dialog.row} onClose={close} />}
      {dialog?.type === 'json' && <JsonDialog title={`${dialog.view.name} v${dialog.view.version}`} subtitle={`${dialog.view.status} · ${typeLabel(dialog.view.result_type)}`} json={dialog.view.data} onClose={close} />}
      {dialog?.type === 'history' && (
        <HistoryDialog
          kind={tab}
          row={dialog.row}
          onClose={close}
          onView={(v) => view(dialog.row, v.version)}
          onReactivate={(version) => withActor(() => setDialog({ type: 'remarks', row: dialog.row, action: 'reactivate', version }))}
        />
      )}
    </div>
  );
}
