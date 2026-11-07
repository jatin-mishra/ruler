// Decision-tree builder in two steps: 1. details (case, name, description, returns), 2. the full-screen tree canvas.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, typeLabel, type CaseView, type ReturnSpec, type TypeCatalog, type ValidationError, type VersionView } from './api';
import { AddButtons, TreeBranch, TreeContext } from './canvas';
import { cached, readStore, useAsync, writeStore } from './hooks';
import {
  assignErrors,
  draftFromJson,
  draftToJson,
  nodePaths,
  parseSample,
  replaceAt,
  reshapeValues,
  ROOT_PATH,
  sampleSkeleton,
  treeProblems,
  type TreeDraft,
  type TreeNode,
} from './model';
import { Dropdown } from './dropdown';
import { EditorContext, type EditorEnv } from './operand';
import { SamplePanel, useRun } from './run';
import { ApiErrorBox, Button, ErrorList, Icon, Modal, StatusBadge, useToast } from './ui';

export type EditorMode = 'new' | 'edit' | 'view';

const ROUNDINGS = ['HALF_UP', 'HALF_EVEN', 'HALF_DOWN', 'UP', 'DOWN', 'CEILING', 'FLOOR'];
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2;
const READABLE_ZOOM = 0.6; // opening a big tree zooms out to fit, but not below this
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +z.toFixed(2)));

export function EditorPage({
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
  // What to open: view → the given version (or ACTIVE); edit → ACTIVE, else latest; a pending draft opens read-only.
  const source = useAsync(mode === 'new' ? null : `src|${caseName}|${name}|${mode}|${version ?? ''}`, async () => {
    const rows = await api.list('decision-trees', caseName);
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`${caseName}:${name} does not exist`);
    const v = mode === 'view' ? version ?? row.active_version ?? row.latest_version : row.draft_version ?? row.active_version ?? row.latest_version;
    return { row, view: await api.get('decision-trees', caseName, name!, v) };
  });

  if (types.error || cases.error || source.error) return <div className="page"><ApiErrorBox error={types.error ?? cases.error ?? source.error} /></div>;
  if (!types.data || !cases.data || (mode !== 'new' && !source.data)) return <div className="page empty">Loading…</div>;

  const loaded = source.data;
  const blockedByDraft = mode === 'edit' && !!loaded?.row.draft_version;
  return (
    <Builder
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

function Builder({
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
  const [draft, setDraft] = useState<TreeDraft>(() =>
    loaded
      ? draftFromJson(loaded.data, loaded.sample_data)
      : { caseName: initialCase, name: '', description: '', returns: { container_type: 'primitive', data_type: 'string' }, root: null, sample: '' },
  );
  const [step, setStep] = useState<'details' | 'build'>(isNew ? 'details' : 'build');
  const [sampleOpen, toggleSample, openSample] = useSamplePanel();
  // Calculate runs the saved version on screen (there is no API to run an unsaved definition).
  const runner = useRun('decision-trees', draft.caseName, draft.name, loaded?.version);
  const [dirty, setDirty] = useState(false);
  const [checked, setChecked] = useState<ValidationError[] | null>(null); // last whole-tree check
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

  const attrsKey = `attrs|${draft.caseName}`;
  const attrs = useAsync(attrsKey, () => cached(attrsKey, () => api.attributes(draft.caseName).then((r) => r.attributes)));

  // No sample yet (new tree, a case change, or a version saved before samples existed): start from the case's paths.
  useEffect(() => {
    if (attrs.data && !draft.sample.trim() && !readOnly) setDraft((d) => ({ ...d, sample: JSON.stringify(sampleSkeleton(attrs.data!), null, 2) }));
  }, [attrs.data, draft.sample, readOnly]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const update = (next: Partial<TreeDraft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setDirty(true);
    setChecked(null); // whole-tree errors are stale after any edit
  };
  const setAt = (path: string, node: TreeNode | null) => {
    runner.clear(); // the last run's highlights no longer match the tree
    setDraft((d) => ({ ...d, root: replaceAt(d.root, path, node) }));
    setDirty(true);
    setChecked(null);
  };

  const paths = useMemo(() => nodePaths(draft.root), [draft.root]);
  const { byNode, tree: treeLevel } = useMemo(() => assignErrors(checked ?? [], paths), [checked, paths]);
  const sample = parseSample(draft.sample);
  const problems = [...treeProblems(draft.root), ...(sample.error ? [`Sample input: ${sample.error}`] : [])];

  const env: EditorEnv = { caseName: draft.caseName, attrs: attrs.data ?? [], dataTypes: types.data_types, returns: draft.returns, readOnly };
  const json = () => draftToJson({ ...draft, name: draft.name.trim() }, env.attrs);
  const checkTree = async (): Promise<boolean> => {
    const res = await api.validateTree(json(), sample.value);
    setChecked(res.errors);
    return res.valid;
  };
  const toList = () => go(`/?case=${encodeURIComponent(draft.caseName)}`);
  const back = () => (dirty && !readOnly ? setLeaving(true) : toList());

  return (
    <EditorContext.Provider value={env}>
      <TreeContext.Provider value={{ setAt, treeErrors: byNode, collapse, report, trace: runner.trace }}>
        {step === 'details' ? (
          <DetailsStep
            noun="tree"
            draft={draft}
            hasContent={!!draft.root}
            onReturns={(r) =>
              update({ returns: r, root: r.container_type !== draft.returns.container_type ? reshapeValues(draft.root, r.container_type) : draft.root })
            }
            onCaseChange={(caseName) => update({ caseName, root: null, sample: '' })}
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
                  {draft.returns.scale != null && <span className="muted small"> scale {draft.returns.scale}</span>}
                  {draft.returns.rounding && <span className="muted small"> · {draft.returns.rounding}</span>}
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
                  <Button variant="primary" onClick={() => go(`/tree/${encodeURIComponent(draft.caseName)}/${encodeURIComponent(draft.name)}?mode=edit`)}>
                    <Icon name="edit" /> Edit as new draft
                  </Button>
                )
              ) : (
                <>
                  <Button
                    disabled={!draft.root || !!sample.error}
                    title={sample.error ? `Sample input: ${sample.error}` : 'Check the whole tree and the sample input'}
                    onClick={() =>
                      checkTree().then(
                        (ok) => toast(ok ? 'ok' : 'error', ok ? 'The whole tree is valid' : 'The tree has errors; they are shown on the cards'),
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
              autoFit={!!loaded}
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
                    cannotRun={loaded ? undefined : 'Save the tree first: Calculate runs a saved version.'}
                    runNote={loaded ? `Runs saved v${loaded.version}${dirty && !readOnly ? ' — your unsaved changes are not included' : ''}.` : undefined}
                  />
                )
              }
              content={
                draft.root ? (
                  <TreeBranch node={draft.root} path={ROOT_PATH} />
                ) : (
                  <div className="start">
                    <div className="start-icon">
                      <Icon name="tree" size={28} />
                    </div>
                    <div className="start-title">Start your tree</div>
                    <p className="muted small">
                      A <b>condition</b> checks something and splits into FALSE (left) and TRUE (right). A <b>value</b> is the result and ends a branch.
                    </p>
                    {!readOnly && <AddButtons path={ROOT_PATH} big />}
                  </div>
                )
              }
            >
              {!readOnly && <CheckPanel problems={problems} treeErrors={treeLevel} />}
            </Canvas>
          </div>
        )}

        {saving && (
          <SaveDialog
            isNew={isNew}
            nextVersion={isNew ? 1 : latestVersion + 1}
            onClose={() => setSaving(false)}
            onSave={async (remarks) => {
              if (!(await checkTree())) throw new Error('The tree has errors; they are shown on the cards');
              const saved = isNew
                ? await api.create('decision-trees', json(), sample.value, remarks || undefined)
                : await api.update('decision-trees', draft.caseName, draft.name, json(), sample.value, remarks);
              setDirty(false);
              toast('ok', `Saved ${saved.name} as DRAFT v${saved.version}. Approve it to make it serve.`);
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
            subtitle="Your edits to this tree have not been saved."
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

export const SummaryItem = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <span className="summary-item">
    <span className="summary-label">{label}</span>
    {children}
  </span>
);

// ---------- step 1: details ----------

const SHAPES: { value: ReturnSpec['container_type']; title: string; example: string }[] = [
  { value: 'primitive', title: 'Single value', example: '0.05' },
  { value: 'list', title: 'List of values', example: '[a, b, c]' },
  { value: 'map', title: 'Map', example: '{ "key": value }' },
];

export interface DetailsDraft {
  caseName: string;
  name: string;
  description: string;
  returns: ReturnSpec;
  sample: string;
}

export function DetailsStep({
  noun,
  draft,
  hasContent,
  onReturns,
  onCaseChange,
  isNew,
  cases,
  types,
  onChange,
  sampleError,
  onCancel,
  onContinue,
}: {
  noun: 'tree' | 'expression';
  draft: DetailsDraft;
  /** Something is built already (changing the case or shape then resets it). */
  hasContent: boolean;
  onReturns: (r: ReturnSpec) => void;
  onCaseChange: (caseName: string) => void;
  isNew: boolean;
  cases: CaseView[];
  types: TypeCatalog;
  onChange: (next: Partial<DetailsDraft>) => void;
  sampleError?: string;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const caseInfo = useAsync(`case|${draft.caseName}`, () => cached(`case|${draft.caseName}`, () => api.attributes(draft.caseName)));
  const setReturns = onReturns;
  const isTree = noun === 'tree';
  const nameMissing = !draft.name.trim();
  const enumMissing = draft.returns.data_type === 'enum' && !draft.returns.allowed_values?.length;
  const blocker = nameMissing
    ? `Give the ${noun} a name`
    : enumMissing
      ? 'List the values the enum can take'
      : sampleError
        ? `Sample input: ${sampleError}`
        : undefined;
  const locked = !isNew; // case, name and return type are fixed after v1

  return (
    <div className="details">
      <form
        className="details-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocker) onContinue();
        }}
      >
        <div className="stepper">
          <span className="step on">
            <span className="step-n">1</span> Details
          </span>
          <span className="step-line" />
          <span className="step">
            <span className="step-n">2</span> Build the {noun}
          </span>
        </div>
        <h1>{isNew ? (isTree ? 'New decision tree' : 'New expression') : `Details · ${draft.name}`}</h1>
        <p className="muted">
          {isNew
            ? isTree
              ? 'Say what the tree is for and what it returns. You build the conditions on the next screen.'
              : 'Say what the expression calculates and what it returns. You build it on the next screen.'
            : 'Case, name and return type are fixed after v1; callers depend on them.'}
        </p>

        <div className="details-grid">
          <label className="field">
            <span className="field-label">Case</span>
            <Dropdown ariaLabel="Case" value={draft.caseName} disabled={locked} onChange={onCaseChange} options={cases.map((c) => ({ value: c.name, label: c.name, meta: `${c.attribute_count} attributes` }))} />
            <span className="hint">
              {caseInfo.data?.description ?? ' '}
              {caseInfo.data && ` · ${caseInfo.data.attributes.length} attributes`}
              {isNew && hasContent && ` · changing the case clears the ${noun}`}
            </span>
          </label>
          <label className="field">
            <span className="field-label">Name {isNew && <span className="req">*</span>}</span>
            <input value={draft.name} disabled={locked} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. registration-fee" autoFocus={isNew} />
            <span className="hint">
              Key <code>{draft.caseName}:{draft.name.trim() || '…'}</code>
            </span>
          </label>
        </div>

        <label className="field">
          <span className="field-label">Description</span>
          <textarea rows={2} value={draft.description} onChange={(e) => onChange({ description: e.target.value })} placeholder={isTree ? 'What does this tree decide?' : 'What does this expression calculate?'} />
        </label>

        <div className="field">
          <span className="field-label">Returns</span>
          <div className="shapes" role="radiogroup" aria-label="Return shape">
            {SHAPES.map((s) => (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={draft.returns.container_type === s.value}
                disabled={locked}
                className={`shape ${draft.returns.container_type === s.value ? 'on' : ''}`}
                onClick={() => setReturns({ ...draft.returns, container_type: s.value })}
              >
                <span className="shape-title">{s.title}</span>
                <code className="shape-example">{s.example}</code>
              </button>
            ))}
          </div>
        </div>

        <div className="details-grid">
          <label className="field">
            <span className="field-label">{draft.returns.container_type === 'primitive' ? 'Data type' : 'Value type'}</span>
            <Dropdown
              ariaLabel="Data type"
              value={draft.returns.data_type}
              disabled={locked}
              onChange={(t) => setReturns({ ...draft.returns, data_type: t, scale: null, rounding: null, allowed_values: null })}
              options={types.data_types.filter((t) => t.name !== 'object').map((t) => ({ value: t.name, label: t.name, meta: t.numeric ? 'number' : undefined }))}
            />
            {draft.returns.container_type === 'map' && <span className="hint">Keys are always text.</span>}
          </label>
          {draft.returns.data_type === 'enum' && (
            <label className="field">
              <span className="field-label">
                Allowed values <span className="req">*</span>
              </span>
              <ValuesInput values={draft.returns.allowed_values ?? []} disabled={locked} onChange={(allowed_values) => setReturns({ ...draft.returns, allowed_values })} />
              <span className="hint">Comma-separated; letters, digits, _ and - only.</span>
            </label>
          )}
          {draft.returns.data_type === 'big_decimal' && (
            <div className="row gap-sm">
              <label className="field grow">
                <span className="field-label">Scale</span>
                <input
                  type="number"
                  min={0}
                  value={draft.returns.scale ?? ''}
                  disabled={locked}
                  placeholder="none"
                  onChange={(e) => setReturns({ ...draft.returns, scale: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </label>
              <label className="field grow">
                <span className="field-label">Rounding</span>
                <Dropdown
                  ariaLabel="Rounding"
                  value={draft.returns.rounding ?? ''}
                  disabled={locked}
                  onChange={(r) => setReturns({ ...draft.returns, rounding: r || null })}
                  options={[{ value: '', label: 'default' }, ...ROUNDINGS.map((r) => ({ value: r, label: r }))]}
                />
              </label>
            </div>
          )}
        </div>

        <div className="returns-summary">
          {isTree ? 'Every value in the tree returns' : 'The expression returns'} <span className="type-chip">{typeLabel(draft.returns)}</span>
          {isNew && hasContent && isTree && <span className="hint"> · changing the shape resets value nodes</span>}
        </div>

        <div className="field">
          <span className="field-label">
            Sample input <span className="req">*</span>
          </span>
          <span className="hint">
            A real-looking request for this case. It is saved with every version, every attribute path the {noun} uses is checked against it, and approval
            uses it by default. Pre-filled from the case's attribute paths.
          </span>
          <textarea
            className={`code-area ${sampleError ? 'invalid' : ''}`}
            rows={10}
            spellCheck={false}
            value={draft.sample}
            onChange={(e) => onChange({ sample: e.target.value })}
            aria-label="Sample input JSON"
          />
          {sampleError && <span className="field-error">{sampleError}</span>}
          {caseInfo.data && (
            <button type="button" className="link" onClick={() => onChange({ sample: JSON.stringify(sampleSkeleton(caseInfo.data!.attributes), null, 2) })}>
              Reset to the template from attribute paths
            </button>
          )}
        </div>

        <div className="details-foot">
          <Button onClick={onCancel} disabled={!isNew && !!sampleError} title={!isNew ? sampleError : undefined}>
            {isNew ? 'Cancel' : `Back to ${noun}`}
          </Button>
          {isNew && (
            <button type="submit" className="btn btn-primary" disabled={!!blocker} title={blocker}>
              Continue to {noun} <Icon name="next" size={14} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Comma-separated values; the text is kept as typed so commas and spaces can be entered. */
function ValuesInput({ values, disabled, onChange }: { values: string[]; disabled: boolean; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(values.join(', '));
  return (
    <input
      value={text}
      disabled={disabled}
      placeholder="e.g. LOW, MEDIUM, HIGH"
      onChange={(e) => {
        setText(e.target.value);
        onChange([...new Set(e.target.value.split(',').map((v) => v.trim()).filter(Boolean))]);
      }}
    />
  );
}

// ---------- step 2: canvas with zoom ----------

export function Canvas({
  readOnly,
  content,
  autoFit,
  align = 'center',
  side,
  children,
}: {
  readOnly: boolean;
  /** What is drawn on the canvas (a tree, or an expression card). */
  content: React.ReactNode;
  autoFit: boolean;
  /** A tree grows both ways from the middle; an expression ladder grows right and down from the top left. */
  align?: 'center' | 'start';
  /** A panel docked on the right; the canvas shrinks beside it. */
  side?: React.ReactNode;
  /** Floating panels over the canvas. */
  children?: React.ReactNode;
}) {
  const [zoom, setZoom] = useState(1);
  const wrap = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLDivElement>(null);

  /** Largest zoom (≤ 100%) at which the whole tree fits the visible area. */
  /** Zoom out until the whole tree fits, but never below `floor` (cards must stay readable; the rest scrolls). */
  const fit = (floor = ZOOM_MIN) => {
    const w = wrap.current;
    const t = tree.current?.firstElementChild as HTMLElement | null;
    if (!w || !t) return;
    const rect = t.getBoundingClientRect();
    const natural = { w: rect.width / zoom + 80, h: rect.height / zoom + 120 };
    setZoom(clampZoom(Math.max(floor, Math.min(1, w.clientWidth / natural.w, w.clientHeight / natural.h))));
  };

  // A loaded tree that is wider than the screen opens zoomed out to fit.
  useLayoutEffect(() => {
    if (!autoFit) return;
    const w = wrap.current;
    const t = tree.current?.firstElementChild as HTMLElement | null;
    if (w && t && t.getBoundingClientRect().width + 80 > w.clientWidth) {
      fit(READABLE_ZOOM);
      // still wider than the screen: open on the root (the middle of a centred tree), not the far left
      if (align === 'center') requestAnimationFrame(() => w.scrollTo({ left: (w.scrollWidth - w.clientWidth) / 2 }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl/⌘ + wheel (and trackpad pinch) zooms the canvas, not the page.
  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z * (1 - e.deltaY * 0.0025)));
    };
    w.addEventListener('wheel', onWheel, { passive: false });
    return () => w.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="canvas-area">
      <div className="canvas-stage">
        <div className="canvas-wrap" ref={wrap}>
          <fieldset disabled={readOnly} className="canvas-fieldset">
            <div className={`canvas canvas-${align}`} ref={tree} style={{ zoom }}>
              {content}
            </div>
          </fieldset>
        </div>
        {children}
        <div className="zoom" role="group" aria-label="Zoom">
          <button className="icon-btn" aria-label="Zoom out" title="Zoom out (Ctrl/⌘ + scroll)" onClick={() => setZoom((z) => clampZoom(z - 0.1))}>
            <Icon name="zoomOut" />
          </button>
          <button className="zoom-val" onClick={() => setZoom(1)} title="Reset to 100%">
            {Math.round(zoom * 100)}%
          </button>
          <button className="icon-btn" aria-label="Zoom in" title="Zoom in (Ctrl/⌘ + scroll)" onClick={() => setZoom((z) => clampZoom(z + 0.1))}>
            <Icon name="zoomIn" />
          </button>
          <span className="zoom-sep" />
          <button className="icon-btn" aria-label="Fit to screen" title="Fit the whole tree" onClick={() => fit()}>
            <Icon name="fit" />
          </button>
        </div>
      </div>
      {side}
    </div>
  );
}

/** Whether the sample-input panel is docked open; remembered per viewer, folded by default. */
export function useSamplePanel(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(() => readStore('ruler.samplePanel') === 'open');
  const set = (next: boolean) => {
    writeStore('ruler.samplePanel', next ? 'open' : 'closed');
    setOpen(next);
  };
  return [open, () => set(!open), () => set(true)];
}

/** Top-bar toggle for the sample panel; flags a problem with the sample even when folded. */
export function SampleToggle({ open, error, onToggle }: { open: boolean; error?: string; onToggle: () => void }) {
  return (
    <Button variant="ghost" className={`${open ? 'is-on' : ''} ${error ? 'danger-text' : ''}`} onClick={onToggle} title={error ?? (open ? 'Hide the sample input' : 'Show the sample input')}>
      <Icon name={error ? 'alert' : 'code'} /> Sample input
    </Button>
  );
}

/** Floating bottom-left: what still blocks saving, and errors that belong to no card. */
export function CheckPanel({ problems, treeErrors }: { problems: string[]; treeErrors: ValidationError[] }) {
  const [open, setOpen] = useState(true);
  const count = problems.length + treeErrors.length;
  if (count === 0)
    return (
      <div className="check-panel check-ok">
        <Icon name="check" /> Ready to save
      </div>
    );
  return (
    <div className={`check-panel ${treeErrors.length ? 'check-error' : 'check-todo'}`}>
      <button className="check-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="alert" /> {count} {count === 1 ? 'thing' : 'things'} to finish
        <span className="muted small">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="check-body">
          {treeErrors.length > 0 && <ErrorList errors={treeErrors} />}
          <ul>
            {problems.slice(0, 8).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {problems.length > 8 && <li>…and {problems.length - 8} more</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

export function SaveDialog({
  isNew,
  nextVersion,
  onClose,
  onSave,
  onFailed,
}: {
  isNew: boolean;
  nextVersion: number;
  onClose: () => void;
  onSave: (remarks: string) => Promise<void>;
  onFailed: (e: unknown) => void;
}) {
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const required = !isNew; // every update records why (spec §10.2)
  return (
    <Modal
      title={`Save as DRAFT v${nextVersion}`}
      subtitle={isNew ? 'It starts as a draft; approve it on the Rules page to make it serve.' : 'The ACTIVE version keeps serving until this draft is approved.'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || (required && !remarks.trim())}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await onSave(remarks.trim());
              } catch (e) {
                setError(e);
                onFailed(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save draft'}
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">
          What changed? {required ? <span className="req">*</span> : <span className="muted">(optional)</span>}
        </span>
        <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. add a concession for women buyers" autoFocus />
      </label>
      <ApiErrorBox error={error} />
    </Modal>
  );
}

/** Collapse or expand every card and value row at once. */
/** One button: "Expand all" while anything is folded, "Collapse all" once everything is open. */
export function FoldAll({ allOpen, onFold }: { allOpen: boolean; onFold: (open: boolean) => void }) {
  return (
    <Button
      variant="ghost"
      title={allOpen ? 'Minimize every card to its description' : 'Open every card and every value'}
      onClick={() => onFold(!allOpen)}
    >
      <Icon name={allOpen ? 'collapse' : 'expand'} /> {allOpen ? 'Collapse all' : 'Expand all'}
    </Button>
  );
}
