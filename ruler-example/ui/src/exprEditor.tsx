// Expression builder: 1. details (case, name, description, returns, sample input), 2. one expression card on the canvas.
import { useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError, typeLabel, type CaseView, type TypeCatalog, type ValidationError, type VersionView } from './api';
import { CardHead, FoldControl, TreeContext, useFolding, type CardState } from './canvas';
import { Canvas, CheckPanel, DetailsStep, FoldAll, SampleToggle, SaveDialog, SummaryItem, useSamplePanel, type EditorMode } from './editor';
import { SamplePanel, useRun } from './run';
import { ExpressionSlot } from './expression';
import { cached, useAsync, useDebounced } from './hooks';
import { exprDraftFromJson, exprDraftToJson, operandComplete, operandToJson, parseSample, returnSlot, sampleSkeleton, showValue, stepOf, type ExprDraft } from './model';
import { EditorContext, type EditorEnv } from './operand';
import { ApiErrorBox, Button, Icon, Modal, StatusBadge, useToast } from './ui';

const BODY_PATH = '$.expression';
const EMPTY_ERRORS = new Map<string, ValidationError[]>();

export function ExprEditorPage({
  mode,
  caseName,
  name,
  version,
  go,
  withActor,
}: {
  mode: EditorMode;
  caseName: string;
  name?: string;
  version?: number;
  go: (hash: string) => void;
  withActor: (fn: () => void) => void;
}) {
  const types = useAsync('types', () => cached('types', api.types));
  const cases = useAsync('cases', () => cached('cases', api.cases));
  const source = useAsync(mode === 'new' ? null : `xsrc|${caseName}|${name}|${mode}|${version ?? ''}`, async () => {
    const rows = await api.list('expressions', caseName);
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`${caseName}:${name} does not exist`);
    const v = mode === 'view' ? version ?? row.active_version ?? row.latest_version : row.draft_version ?? row.active_version ?? row.latest_version;
    return { row, view: await api.get('expressions', caseName, name!, v) };
  });
  if (types.error || cases.error || source.error) return <div className="page"><ApiErrorBox error={types.error ?? cases.error ?? source.error} /></div>;
  if (!types.data || !cases.data || (mode !== 'new' && !source.data)) return <div className="page empty">Loading…</div>;
  const loaded = source.data;
  const blockedByDraft = mode === 'edit' && !!loaded?.row.draft_version;
  return (
    <ExprBuilder
      key={`${mode}|${caseName}|${name}|${loaded?.view.version ?? ''}`}
      types={types.data}
      cases={cases.data}
      initialCase={caseName}
      loaded={loaded?.view}
      readOnly={mode === 'view' || blockedByDraft}
      isNew={mode === 'new'}
      draftVersion={loaded?.row.draft_version ?? null}
      latestVersion={loaded?.row.latest_version ?? 0}
      blockedByDraft={blockedByDraft}
      go={go}
      withActor={withActor}
    />
  );
}

function ExprBuilder({
  types,
  cases,
  initialCase,
  loaded,
  readOnly,
  isNew,
  draftVersion,
  latestVersion,
  blockedByDraft,
  go,
  withActor,
}: {
  types: TypeCatalog;
  cases: CaseView[];
  initialCase: string;
  loaded?: VersionView;
  readOnly: boolean;
  isNew: boolean;
  draftVersion: number | null;
  latestVersion: number;
  blockedByDraft: boolean;
  go: (hash: string) => void;
  withActor: (fn: () => void) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<ExprDraft>(() =>
    loaded
      ? exprDraftFromJson(loaded.data, loaded.sample_data)
      : { caseName: initialCase, name: '', description: '', returns: { container_type: 'primitive', data_type: 'big_decimal' }, body: null, sample: '' },
  );
  const [step, setStep] = useState<'details' | 'build'>(isNew ? 'details' : 'build');
  const [dirty, setDirty] = useState(false);
  const [checked, setChecked] = useState<ValidationError[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [collapse, setCollapse] = useState({ open: true, n: 0 });
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const report = useCallback((id: string, open: boolean | null) => {
    setFolds((f) => {
      if (open === null) {
        if (!(id in f)) return f;
        const { [id]: _gone, ...rest } = f;
        return rest;
      }
      return f[id] === open ? f : { ...f, [id]: open };
    });
  }, []);
  const allOpen = Object.values(folds).every(Boolean);
  const [sampleOpen, toggleSample, openSample] = useSamplePanel();
  // Calculate runs the saved version on screen (there is no API to run an unsaved definition).
  const runner = useRun('expressions', draft.caseName, draft.name, loaded?.version);

  const attrsKey = `attrs|${draft.caseName}`;
  const attrs = useAsync(attrsKey, () => cached(attrsKey, () => api.attributes(draft.caseName).then((r) => r.attributes)));
  useEffect(() => {
    if (attrs.data && !draft.sample.trim() && !readOnly) setDraft((d) => ({ ...d, sample: JSON.stringify(sampleSkeleton(attrs.data!), null, 2) }));
  }, [attrs.data, draft.sample, readOnly]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const update = (next: Partial<ExprDraft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setDirty(true);
    setChecked(null);
  };

  const env: EditorEnv = { caseName: draft.caseName, attrs: attrs.data ?? [], dataTypes: types.data_types, returns: draft.returns, readOnly };
  const sample = parseSample(draft.sample);
  const problems = [
    ...(operandComplete(draft.body) ? [] : ['The expression is not finished']),
    ...(sample.error ? [`Sample input: ${sample.error}`] : []),
  ];
  const json = () => exprDraftToJson(draft, env.attrs);
  const checkAll = async () => {
    const res = await api.validateExpression(json(), sample.value);
    setChecked(res.errors);
    return res.valid;
  };
  const toList = () => go(`/?case=${encodeURIComponent(draft.caseName)}&tab=expressions`);
  const back = () => (dirty && !readOnly ? setLeaving(true) : toList());
  const cardErrors = (checked ?? []).filter((e) => e.path.startsWith(BODY_PATH));
  const otherErrors = (checked ?? []).filter((e) => !e.path.startsWith(BODY_PATH));

  return (
    <EditorContext.Provider value={env}>
      <TreeContext.Provider value={{ setAt: () => {}, treeErrors: EMPTY_ERRORS, collapse, report, trace: runner.trace }}>
        {step === 'details' ? (
          <DetailsStep
            noun="expression"
            draft={draft}
            hasContent={!!draft.body}
            onReturns={(returns) => update({ returns })}
            onCaseChange={(caseName) => update({ caseName, body: null, sample: '' })}
            isNew={isNew}
            cases={cases}
            types={types}
            onChange={update}
            sampleError={sample.error}
            onCancel={isNew ? back : () => setStep('build')}
            onContinue={() => setStep('build')}
          />
        ) : (
          <div className="editor">
            <div className="editor-bar">
              <button className="icon-btn" aria-label="Back to rules" onClick={back}>
                <Icon name="back" />
              </button>
              <div className="summary">
                <strong className="summary-name">{draft.name}</strong>
                {loaded && <StatusBadge status={loaded.status} version={loaded.version} />}
                <SummaryItem label="Case">{draft.caseName}</SummaryItem>
                <SummaryItem label="Returns">
                  <span className="type-chip">{typeLabel(draft.returns)}</span>
                </SummaryItem>
                <span className="summary-desc" title={draft.description}>
                  {draft.description || <span className="muted">No description</span>}
                </span>
                {!readOnly && (
                  <button className="link" onClick={() => setStep('details')}>
                    <Icon name="edit" size={13} /> Edit details
                  </button>
                )}
              </div>
              {dirty && <span className="unsaved">Unsaved</span>}
              <SampleToggle open={sampleOpen} error={sample.error} onToggle={toggleSample} />
              <Button
                variant="ghost"
                disabled={!loaded || !!sample.error || runner.state.running}
                title={!loaded ? 'Save it first: Calculate runs a saved version' : sample.error ?? `Run v${loaded.version} with the sample input`}
                onClick={() => {
                  openSample();
                  runner.run(sample.value);
                }}
              >
                <Icon name="play" /> {runner.state.running ? 'Calculating…' : 'Calculate'}
              </Button>
              <FoldAll allOpen={allOpen} onFold={(open) => setCollapse((c) => ({ open, n: c.n + 1 }))} />
              {readOnly ? (
                !draftVersion && (
                  <Button variant="primary" onClick={() => go(`/expr/${encodeURIComponent(draft.caseName)}/${encodeURIComponent(draft.name)}?mode=edit`)}>
                    <Icon name="edit" /> Edit as new draft
                  </Button>
                )
              ) : (
                <>
                  <Button
                    disabled={!draft.body || !!sample.error}
                    onClick={() =>
                      checkAll().then(
                        (ok) => toast(ok ? 'ok' : 'error', ok ? 'The expression is valid' : 'The expression has errors; they are shown on the card'),
                        (e) => toast('error', e.message),
                      )
                    }
                  >
                    <Icon name="check" /> Validate
                  </Button>
                  <Button variant="primary" disabled={problems.length > 0} title={problems[0]} onClick={() => withActor(() => setSaving(true))}>
                    Save as draft
                  </Button>
                </>
              )}
            </div>
            {blockedByDraft && (
              <div className="banner banner-warn">
                <Icon name="alert" /> Draft v{draftVersion} is waiting for approval. Approve or reject it on the Rules page before making another change. Showing the draft.
              </div>
            )}
            <Canvas
              readOnly={readOnly}
              autoFit={false}
              align="start"
              side={
                sampleOpen && (
                  <SamplePanel
                    text={draft.sample}
                    error={sample.error}
                    readOnly={readOnly}
                    onChange={(t) => (readOnly ? setDraft((d) => ({ ...d, sample: t })) : update({ sample: t }))}
                    onClose={toggleSample}
                    run={runner.state}
                    onCalculate={() => runner.run(sample.value)}
                    onClear={runner.clear}
                    cannotRun={loaded ? undefined : 'Save the expression first: Calculate runs a saved version.'}
                    runNote={loaded ? `Runs saved v${loaded.version}${dirty && !readOnly ? ' — your unsaved changes are not included' : ''}.` : undefined}
                  />
                )
              }
              content={
                <ExpressionCard
                  draft={draft}
                  onBody={(body) => {
                    runner.clear(); // the last run's highlights no longer match
                    update({ body });
                  }}
                  extraErrors={cardErrors}
                />
              }
            >
              {!readOnly && <CheckPanel problems={problems} treeErrors={otherErrors} />}
            </Canvas>
          </div>
        )}
        {saving && (
          <SaveDialog
            isNew={isNew}
            nextVersion={isNew ? 1 : latestVersion + 1}
            onClose={() => setSaving(false)}
            onSave={async (remarks) => {
              if (!(await checkAll())) throw new Error('The expression has errors; they are shown on the card');
              const saved = isNew
                ? await api.create('expressions', json(), sample.value, remarks || undefined)
                : await api.update('expressions', draft.caseName, draft.name, json(), sample.value, remarks);
              setDirty(false);
              toast('ok', `Saved ${saved.name} as DRAFT v${saved.version}. Approve it to make it usable.`);
              toList();
            }}
            onFailed={(e) => {
              if (e instanceof ApiError && e.errors.length) setChecked(e.errors);
            }}
          />
        )}
        {leaving && (
          <Modal
            title="Discard changes?"
            subtitle="Your edits to this expression have not been saved."
            onClose={() => setLeaving(false)}
            footer={
              <>
                <Button onClick={() => setLeaving(false)}>Keep editing</Button>
                <Button variant="danger" onClick={toList}>
                  Discard
                </Button>
              </>
            }
          >
            <span />
          </Modal>
        )}
      </TreeContext.Provider>
    </EditorContext.Provider>
  );
}

/** The single card: what the expression is, checked by the server as it is built. */
function ExpressionCard({ draft, onBody, extraErrors }: { draft: ExprDraft; onBody: (b: ExprDraft['body']) => void; extraErrors: ValidationError[] }) {
  const [open, setOpen] = useFolding(true);
  const { trace } = useContext(TreeContext);
  const ran = stepOf(trace, BODY_PATH, 'VALUE');
  const complete = operandComplete(draft.body);
  const body = complete ? JSON.stringify(operandToJson(draft.body)) : null;
  const settled = useDebounced(body, 400);
  const key = settled && settled === body ? `xcard|${draft.caseName}|${settled}` : null;
  const res = useAsync(key, () => api.validateNode(draft.caseName, BODY_PATH, JSON.parse(settled!)));
  const errors = [...(key && res.data ? res.data.errors : []), ...extraErrors];
  const resultType = key ? res.data?.result_type : undefined;
  const mismatch = resultType && typeLabel(resultType) !== typeLabel(returnSlot(draft.returns));
  const state: CardState = errors.length ? 'error' : !complete ? 'incomplete' : !key || res.loading ? 'checking' : 'ok';
  return (
    <div className={`card card-expr card-${state} ${open ? '' : 'card-min'}`}>
      <CardHead
        kind="EXPRESSION"
        badge={ran && <span className="ran-badge ran-true">= {showValue(ran.result)}</span>}
        state={state}
        open={open}
        onToggle={() => setOpen(!open)}
        title={
          <FoldControl className="min-title" onClick={() => setOpen(!open)}>
            {open ? draft.name : draft.description || draft.name}
            {resultType && <span className="type-chip">{typeLabel(resultType)}</span>}
          </FoldControl>
        }
      />
      {open && (
        <div className="card-body">
          <ExpressionSlot value={draft.body} onChange={onBody} slot={returnSlot(draft.returns)} path={BODY_PATH} errors={errors} returns={draft.returns} />
          {mismatch && <div className="hint">Calculates {typeLabel(resultType)}; it must return {typeLabel(draft.returns)} (the server checks widening on save).</div>}
        </div>
      )}
    </div>
  );
}
