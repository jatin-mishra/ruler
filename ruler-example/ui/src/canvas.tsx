// The downward binary tree: condition cards with FALSE (left) / TRUE (right) branches, value cards as leaves.
// Every card reads like an equation (LHS · operator · RHS) and can be minimized to its description.
import { useContext, useState } from 'react';
import { TreeContext, useFolding } from './context';
import { api, typeLabel, type ValidationError } from './api';
import { cached, useAsync, useDebounced } from './hooks';
import { Calculation, ExpressionSlot, formula, useOperandType } from './expression';
import {
  childPath,
  constantType,
  describePath,
  emptyCondition,
  emptyConstant,
  emptyValue,
  fieldErrors,
  findAttribute,
  newRow,
  nodeComplete,
  nodeToJson,
  operandComplete,
  operatorLabel,
  rowPath,
  returnSlot,
  rowValue,
  showValue,
  stepOf,
  valueSlot,
  type Branch,
  type ConditionNode,
  type ExprOperand,
  type Operand,
  type TreeNode,
  type ValueNode,
  type ValueRow,
} from './model';
import { Dropdown } from './dropdown';
import { ExpressionLink, FieldErrors, useEditor } from './operand';
import { ConditionSide } from './condside';
import { Icon } from './ui';

export { TreeContext, useFolding, type TreeOps } from './context';

/**
 * Open/fold control. Not a <button>: the read-only view disables the canvas's form controls, but folding must
 * still work there.
 */
export function FoldControl({ onClick, className, title, label, children }: { onClick: () => void; className: string; title?: string; label?: string; children: React.ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className={className}
      title={title}
      aria-label={label}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </span>
  );
}

export function TreeBranch({ node, path }: { node: TreeNode; path: string }) {
  const { trace } = useContext(TreeContext);
  const checked = node.type === 'condition' ? stepOf(trace, path, 'CONDITION') : undefined;
  const route = (b: Branch) => (!trace ? '' : checked && checked.result === (b === 'success') ? 'branch-taken' : 'branch-skipped');
  return (
    <div className="tnode">
      {node.type === 'condition' ? <ConditionCard node={node} path={path} /> : <ValueCard node={node} path={path} />}
      {node.type === 'condition' && (node.failure || node.success) && (
        <div className="children">
          {(['failure', 'success'] as Branch[]).map((b) => (
            <div key={b} className={`branch branch-${b} ${route(b)}`}>
              <EdgeLabel branch={b} />
              {node[b] ? <TreeBranch node={node[b]!} path={childPath(path, b)} /> : <Ghost path={childPath(path, b)} branch={b} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const EdgeLabel = ({ branch }: { branch: Branch }) => (
  <span className={`edge-label edge-${branch}`}>{branch === 'success' ? 'TRUE' : 'FALSE'}</span>
);

/** The empty side of a condition whose other side is already filled. */
function Ghost({ path, branch }: { path: string; branch: Branch }) {
  const { readOnly } = useEditor();
  return (
    <div className="ghost">
      <div className="ghost-title">{branch === 'success' ? 'When true' : 'When false'}</div>
      {readOnly ? <div className="hint">Not set</div> : <AddButtons path={path} />}
    </div>
  );
}

export function AddButtons({ path, big }: { path: string; big?: boolean }) {
  const { setAt } = useContext(TreeContext);
  const { returns } = useEditor();
  return (
    <div className={`add-btns ${big ? 'add-btns-big' : ''}`}>
      <button type="button" className="add add-cond" onClick={() => setAt(path, emptyCondition())} title="Add a condition (another IF)">
        <Icon name="plus" size={13} /> Condition
      </button>
      <button type="button" className="add add-val" onClick={() => setAt(path, emptyValue(returns.container_type))} title="Add a value (the result; ends this branch)">
        <Icon name="plus" size={13} /> Value
      </button>
    </div>
  );
}

// ---------- per-card validation (validate-node, lld §16 D2) ----------

export type CardState = 'incomplete' | 'checking' | 'ok' | 'error';

function useCardCheck(node: TreeNode, path: string): { state: CardState; errors: ValidationError[] } {
  const { caseName, attrs, returns } = useEditor();
  const { treeErrors } = useContext(TreeContext);
  const complete = nodeComplete(node);
  const body = complete ? JSON.stringify(nodeToJson(node, attrs, false)) : null;
  const settled = useDebounced(body, 400);
  const withReturns = node.type === 'value';
  const key = settled && settled === body ? `${path}|${settled}|${withReturns ? JSON.stringify(returns) : ''}` : null;
  const res = useAsync(key, () => api.validateNode(caseName, path, JSON.parse(settled!), withReturns ? returns : undefined));
  const fromTree = treeErrors.get(path) ?? [];
  const fromCard = key && res.data ? res.data.errors : [];
  const seen = new Set(fromCard.map((e) => e.path + e.code));
  const errors = [...fromCard, ...fromTree.filter((e) => !seen.has(e.path + e.code))];
  if (res.error) errors.push({ path, code: 'CHECK_FAILED', message: res.error.message });
  const state: CardState = errors.length ? 'error' : !complete ? 'incomplete' : !key || res.loading ? 'checking' : 'ok';
  return { state, errors };
}

const STATE_TEXT: Record<CardState, string> = { incomplete: 'Not finished', checking: 'Checking…', ok: 'Valid', error: 'Has errors' };

export function CardHead({
  kind,
  path,
  state,
  open,
  onToggle,
  onDelete,
  title,
  badge,
}: {
  kind: 'IF' | 'RETURN' | 'EXPRESSION';
  path?: string;
  state: CardState;
  open: boolean;
  onToggle: () => void;
  onDelete?: () => void;
  title: React.ReactNode;
  /** What the last run did here, e.g. "TRUE" or "= 720,000". */
  badge?: React.ReactNode;
}) {
  const { readOnly } = useEditor();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="card-head">
      <span className={`kind kind-${kind === 'IF' ? 'if' : 'ret'}`}>{kind}</span>
      <div className="card-title">{title}</div>
      {badge}
      <span className={`state-dot state-${state}`} title={STATE_TEXT[state]} aria-label={STATE_TEXT[state]} />
      <FoldControl className="icon-btn" label={open ? 'Minimize' : 'Expand'} title={open ? 'Minimize' : 'Expand'} onClick={onToggle}>
        <Icon name={open ? 'collapse' : 'expand'} size={15} />
      </FoldControl>
      {onDelete &&
        !readOnly &&
        (confirm ? (
          <span className="confirm">
            <button type="button" className="link danger" onClick={onDelete}>
              Delete
            </button>
            <button type="button" className="link" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button type="button" className="icon-btn" aria-label="Delete node" title={path ? `Delete ${describePath(path)} and everything below it` : 'Delete'} onClick={() => setConfirm(true)}>
            <Icon name="trash" size={15} />
          </button>
        ))}
    </div>
  );
}

// ---------- condition: LHS · operator · RHS ----------

const CONDITION_LABELS: Record<string, string> = {
  equals: '=',
  not_equals: '≠',
  GT: '>',
  LT: '<',
  GTE: '≥',
  LTE: '≤',
  in: 'is one of',
  contains: 'contains',
  contains_any: 'contains any of',
  contains_all: 'contains all of',
  contains_key: 'has key',
  contains_value: 'has value',
  prefix_match: 'starts with',
  suffix_match: 'ends with',
  equals_ignore_case: '= (any case)',
};
const conditionLabel = (name: string) => CONDITION_LABELS[name] ?? name.replace(/_/g, ' ');

function ConditionCard({ node, path }: { node: ConditionNode; path: string }) {
  const { attrs, readOnly } = useEditor();
  const { setAt, trace } = useContext(TreeContext);
  const ran = stepOf(trace, path, 'CONDITION');
  const { state, errors } = useCardCheck(node, path);
  const [open, setOpen] = useFolding(true);
  const set = (patch: Partial<ConditionNode>) => setAt(path, { ...node, ...patch });

  const typeOf = (op: Operand | null) =>
    op?.kind === 'ATTRIBUTE' ? findAttribute(attrs, op.ref)?.type : op?.kind === 'CONSTANT' ? constantType(op) : undefined;
  const lhsType = useOperandType(node.lhs); // a calculated or saved left side is typed by the server
  const lhsKey = lhsType ? `ops|${typeLabel(lhsType)}` : null;
  const ops = useAsync(lhsKey, () => cached(lhsKey!, () => api.operators(lhsType!)));
  const operators = ops.data?.condition ?? [];
  const spec = operators.find((o) => o.name === node.operator);
  // An enum LHS turns a constant RHS into a dropdown (or chips for "is one of") of its values.
  const choices = node.lhs?.kind === 'ATTRIBUTE' ? findAttribute(attrs, node.lhs.ref)?.type.enum_values ?? undefined : undefined;

  const changeLhs = (lhs: Operand | null) => {
    const next = typeOf(lhs);
    const same = lhsType && next && typeLabel(lhsType) === typeLabel(next);
    set(same ? { lhs } : { lhs, operator: '', rhs: null }); // a new left type means new operators
  };
  const changeOperator = (name: string) => {
    const slot = operators.find((o) => o.name === name)?.rhs;
    let rhs = node.rhs;
    if (slot && rhs?.kind === 'CONSTANT' && typeLabel(constantType(rhs)) !== typeLabel(slot)) {
      const carried = rhs.container === 'list' ? rhs.items[0] ?? '' : rhs.value; // keep what was typed
      const fresh = emptyConstant(slot);
      rhs = fresh.container === 'list' ? { ...fresh, items: [carried] } : { ...fresh, value: fresh.dataType === 'boolean' ? fresh.value : carried };
    }
    set({ operator: name, rhs });
  };

  const sentence = `${formula(node.lhs, attrs)} ${node.operator ? conditionLabel(node.operator) : '…'} ${formula(node.rhs, attrs)}`;
  const other = errors.filter((e) => !['lhs', 'rhs', 'operator'].some((f) => fieldErrors([e], `${path}.${f}`).length));

  return (
    <div className={`card card-cond card-${state} ${open ? '' : 'card-min'} ${!trace ? '' : ran ? 'card-ran' : 'card-skipped'}`}>
      <CardHead
        kind="IF"
        badge={ran && <span className={`ran-badge ${ran.result ? 'ran-true' : 'ran-false'}`}>{ran.result ? '✓ TRUE' : '✗ FALSE'}</span>}
        path={path}
        state={state}
        open={open}
        onToggle={() => setOpen(!open)}
        onDelete={() => setAt(path, null)}
        title={
          open ? (
            <input className="desc-input" placeholder="Describe this check (optional)" value={node.description} onChange={(e) => set({ description: e.target.value })} aria-label="Condition description" />
          ) : (
            <FoldControl className="min-title" onClick={() => setOpen(true)} title={sentence}>
              {node.description || sentence}
            </FoldControl>
          )
        }
      />
      {open && (
        <div className="card-body">
          <div className="cgrid">
            <div className="cgrid-head" style={{ gridColumn: 1 }}>Left side</div>
            <div className="cgrid-head" style={{ gridColumn: 2 }}>Operator</div>
            <div className="cgrid-head" style={{ gridColumn: 3 }}>Right side</div>
            <ConditionSide column={1} value={node.lhs} onChange={changeLhs} path={`${path}.lhs`} errors={errors} />
            {/* the operator sits on the value row, so the card reads "left value · operator · right value" */}
            <div className="cgrid-op">
              <Dropdown
                variant="pill"
                className="eq-op"
                ariaLabel="Operator"
                value={node.operator}
                disabled={!lhsType}
                invalid={fieldErrors(errors, `${path}.operator`).length > 0}
                onChange={changeOperator}
                placeholder={lhsType ? 'is…' : '…'}
                minMenuWidth={260}
                options={[
                  ...(node.operator && !spec && !ops.loading ? [{ value: node.operator, label: `${node.operator} (not available)`, disabled: true }] : []),
                  ...operators.map((o) => {
                    const symbol = conditionLabel(o.name);
                    return {
                      value: o.name,
                      label: operatorLabel(o.name).replace(/\s+[=≠<>≤≥]+$/, ''), // words; the symbol sits in front
                      icon: symbol.length <= 2 ? symbol : undefined,
                      short: symbol,
                      meta: o.rhs.container_type === 'primitive' ? undefined : typeLabel(o.rhs), // only when it compares with a list
                    };
                  }),
                ]}
              />
              <FieldErrors errors={fieldErrors(errors, `${path}.operator`)} />
            </div>
            {node.operator ? (
              <ConditionSide column={3} value={node.rhs} onChange={(rhs) => set({ rhs })} slot={spec?.rhs} choices={choices} path={`${path}.rhs`} errors={errors} />
            ) : (
              <div className="cside-cell cside-wait" style={{ gridColumn: 3, gridRow: '2 / 5' }}>
                {lhsType ? 'Pick how to compare first' : 'Pick the left side first'}
              </div>
            )}
          </div>
          {(['lhs', 'rhs'] as const).map(
            (side) =>
              node[side]?.kind === 'EXPR' && (
                <div key={side} className="cond-calc">
                  <div className="cond-calc-label">{side === 'lhs' ? 'Left side' : 'Right side'} is calculated</div>
                  <Calculation value={node[side] as ExprOperand} onChange={(op) => set({ [side]: op })} path={`${path}.${side}`} errors={errors} />
                </div>
              ),
          )}
          {ran && (
            <div className="ran-row" title="What the last Calculate compared">
              <span>{showValue(ran.lhs)}</span>
              <span className="ran-op">{conditionLabel(ran.operation ?? node.operator)}</span>
              <span>{showValue(ran.rhs)}</span>
              <span className="ran-arrow">→ {ran.result ? 'TRUE' : 'FALSE'}</span>
            </div>
          )}
          <FieldErrors errors={other} />
        </div>
      )}
      {!readOnly && (!node.failure || !node.success) && (
        <div className="card-foot">
          {(['failure', 'success'] as Branch[]).map((b) => (
            <div key={b} className={`corner corner-${b}`}>
              {!node[b] && (
                <>
                  <span className={`corner-label edge-${b}`}>
                    <Icon name={b === 'success' ? 'check' : 'x'} size={12} />
                    {b === 'success' ? 'If true' : 'If false'}
                  </span>
                  <AddButtons path={childPath(path, b)} />
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- value: one line per expression, opens into its ladder ----------

function ValueCard({ node, path }: { node: ValueNode; path: string }) {
  const { returns, readOnly, attrs } = useEditor();
  const { setAt, trace } = useContext(TreeContext);
  const ran = stepOf(trace, path, 'VALUE');
  const { state, errors } = useCardCheck(node, path);
  const [open, setOpen] = useFolding(true);
  const set = (patch: Partial<ValueNode>) => setAt(path, { ...node, ...patch });
  // one expression for the whole result must fit the whole return type; a list item / map value fits one element
  const slot = node.shape === 'primitive' ? returnSlot(returns) : valueSlot(returns);
  const setRow = (i: number, patch: Partial<ValueRow>) => set({ rows: node.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  const shown = new Set<ValidationError>();
  const take = (p: string) => {
    const mine = fieldErrors(errors, p);
    mine.forEach((e) => shown.add(e));
    return mine;
  };

  const isMap = node.shape === 'map';
  const summary =
    node.shape === 'primitive'
      ? formula(node.single, attrs)
      : `${node.rows.length} ${isMap ? (node.rows.length === 1 ? 'entry' : 'entries') : node.rows.length === 1 ? 'item' : 'items'}`;

  let body;
  if (node.shape === 'primitive') {
    body = <ValueLine value={node.single} onChange={(single) => set({ single })} slot={slot} path={`${path}.value`} errors={take(`${path}.value`)} ran={rowValue(trace, path, node, null)} />;
  } else {
    body = (
      <div className="rows">
        {node.rows.map((r, i) => {
          const p = rowPath(path, node, i);
          return (
            <ValueLine
              key={r.id}
              label={isMap ? undefined : `${i + 1}`}
              keyValue={isMap ? r.key : undefined}
              onKey={(key) => setRow(i, { key })}
              value={r.value}
              onChange={(value) => setRow(i, { value })}
              onRemove={node.rows.length > 1 ? () => set({ rows: node.rows.filter((_, j) => j !== i) }) : undefined}
              slot={slot}
              path={p}
              errors={take(p)}
              ran={rowValue(trace, path, node, i)}
            />
          );
        })}
        {!readOnly && (
          <button type="button" className="link" onClick={() => set({ rows: [...node.rows, newRow()] })}>
            <Icon name="plus" size={13} /> Add {isMap ? 'entry' : 'item'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`card card-val card-${state} ${open ? '' : 'card-min'} ${!trace ? '' : ran ? 'card-ran' : 'card-skipped'}`}>
      <CardHead
        kind="RETURN"
        badge={ran && <span className="ran-badge ran-true">Returned</span>}
        path={path}
        state={state}
        open={open}
        onToggle={() => setOpen(!open)}
        onDelete={() => setAt(path, null)}
        title={
          <FoldControl className="min-title" onClick={() => setOpen(!open)} title={typeLabel(returns)}>
            {open ? <span className="type-chip">{typeLabel(returns)}</span> : summary}
          </FoldControl>
        }
      />
      {open && (
        <div className="card-body">
          {body}
          <FieldErrors errors={errors.filter((e) => !shown.has(e))} />
        </div>
      )}
    </div>
  );
}

/** One expression as a single line (`key = formula`); click to open it as a ladder. */
function ValueLine({
  value,
  onChange,
  slot,
  path,
  errors,
  label,
  keyValue,
  onKey,
  onRemove,
  ran,
}: {
  ran: { found: boolean; value?: unknown };
  value: Operand | null;
  onChange: (op: Operand | null) => void;
  slot: ReturnType<typeof valueSlot>;
  path: string;
  errors: ValidationError[];
  label?: string;
  keyValue?: string;
  onKey?: (k: string) => void;
  onRemove?: () => void;
}) {
  const { attrs, readOnly, returns } = useEditor();
  const [open, setOpen] = useFolding(!operandComplete(value)); // unfinished rows start open
  const bad = errors.length > 0;
  return (
    <div className={`vline ${open ? 'vline-open' : ''} ${bad ? 'vline-error' : ''}`}>
      <div className="vline-head">
        {label && <span className="vline-n">{label}</span>}
        {keyValue !== undefined && (
          <input className={`key-input ${keyValue.trim() ? '' : 'invalid'}`} value={keyValue} placeholder="key" onChange={(e) => onKey?.(e.target.value)} aria-label="Key" />
        )}
        {keyValue !== undefined && <span className="vline-eq">=</span>}
        <FoldControl className="vline-formula" onClick={() => setOpen(!open)} title={open ? 'Fold to one line' : 'Open'}>
          {operandComplete(value) ? formula(value, attrs) : <span className="muted">{value ? 'not finished…' : 'choose a value…'}</span>}
        </FoldControl>
        {value?.kind === 'REF' && value.key && <ExpressionLink compact refKey={value.key} version={value.version} />}
        {ran.found && <span className="ran-chip" title="What the last Calculate returned">= {showValue(ran.value)}</span>}
        {bad && <Icon name="alert" size={14} />}
        <FoldControl className="icon-btn" label={open ? 'Fold' : 'Open'} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'collapse' : 'expand'} size={14} />
        </FoldControl>
        {!readOnly && onRemove && (
          <button type="button" className="icon-btn" aria-label="Remove row" onClick={onRemove}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      {open && <ExpressionSlot value={value} onChange={onChange} slot={slot} path={path} errors={errors} returns={returns} />}
      {!open && bad && <FieldErrors errors={errors.slice(0, 1)} />}
    </div>
  );
}
