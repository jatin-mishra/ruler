// An expression slot (a value-node row, or an expression's body) and the ladder that builds a calculation.
//
//   Step 1   [ LHS ]  op  [ RHS ]          LHS: constant or attribute
//      ↳ Step 2   [ LHS ]  op  [ RHS ]     RHS: constant, attribute, saved expression, or "Calculate" → next step
import { api, typeLabel, type ReturnSpec, type TypeRef, type ValidationError } from './api';
import { useContext } from 'react';
import { TreeContext } from './context';
import { cached, useAsync } from './hooks';
import {
  arithmeticHint,
  arithmeticShort,
  constantType,
  emptyConstant,
  findAttribute,
  operandComplete,
  operandToJson,
  ownErrors,
  showValue,
  stepOf,
  type ExprOperand,
  type Operand,
} from './model';
import { AttributePicker, ConstantEditor, FieldErrors, exprSummary, useEditor } from './operand';
import { Dropdown } from './dropdown';
import { SlotPicker, useSavedExpressions, type SlotKind } from './slot';
import { Icon, Segmented } from './ui';

/** Static type of an operand: local for leaves, from the server (validate-node) for a calculation. */
export function useOperandType(op: Operand | null): TypeRef | undefined {
  const { caseName, attrs } = useEditor();
  const saved = useSavedExpressions(op?.kind === 'REF' ? undefined : null);
  const json = op?.kind === 'EXPR' && operandComplete(op) ? JSON.stringify(operandToJson(op, attrs)) : null;
  const key = json ? `optype|${caseName}|${json}` : null;
  const calc = useAsync(key, () => cached(key!, () => api.validateNode(caseName, '$', JSON.parse(json!))));
  if (!op) return undefined;
  if (op.kind === 'CONSTANT') return constantType(op);
  if (op.kind === 'ATTRIBUTE') return findAttribute(attrs, op.ref)?.type;
  if (op.kind === 'REF') return saved.data?.find((e) => e.key === op.key)?.result_type;
  if (op.kind === 'EXPR') return calc.data?.result_type ?? undefined;
  return undefined;
}

type Kind = 'CONSTANT' | 'ATTRIBUTE' | 'REF' | 'EXPR';
const KINDS: { value: Kind; label: string }[] = [
  { value: 'CONSTANT', label: 'Constant' },
  { value: 'ATTRIBUTE', label: 'Attribute' },
  { value: 'REF', label: 'Saved' },
  { value: 'EXPR', label: 'Expression' },
];

/** What one value is: a constant, an attribute, a saved expression, or an expression built as a ladder. */
export function ExpressionSlot({
  value,
  onChange,
  slot,
  path,
  errors,
  returns,
}: {
  value: Operand | null;
  onChange: (op: Operand | null) => void;
  slot: TypeRef;
  path: string;
  errors: ValidationError[];
  /** For the note on why a constant has the type it has. */
  returns?: ReturnSpec;
}) {
  const kind = (value && value.kind !== 'RAW' ? value.kind : '') as Kind | '';
  const pick = (k: Kind) => {
    if (k === kind) return;
    if (k === 'CONSTANT') onChange(emptyConstant(slot));
    else if (k === 'ATTRIBUTE') onChange({ kind: 'ATTRIBUTE', ref: '', params: {} });
    else if (k === 'REF') onChange({ kind: 'REF', key: '', version: 0 });
    else onChange({ kind: 'EXPR', op: '', unary: false, lhs: null, rhs: null });
  };
  const mine = ownErrors(errors, path);
  return (
    <div className="xslot">
      <Segmented<Kind | ''> size="sm" value={kind} onChange={(k) => k && pick(k)} options={KINDS} />
      {!value && <div className="hint">Pick what this value is.</div>}
      {value?.kind === 'CONSTANT' && (
        <>
          <ConstantEditor value={value} onChange={onChange} slot={slot} />
          <div className="note">
            <Icon name="alert" size={13} /> The type is <b>{typeLabel(slot)}</b> because {returns ? 'that is what this returns' : 'that is what this slot needs'}.
          </div>
        </>
      )}
      {value?.kind === 'ATTRIBUTE' && <AttributePicker value={value} onChange={onChange} slot={slot} />}
      {value?.kind === 'REF' && (
        <SlotPicker value={value} onChange={onChange} slot={slot} allow={['REF']} path={path} errors={[]} placeholder="Select a saved expression…" />
      )}
      {value?.kind === 'EXPR' && <Calculation value={value} onChange={onChange} slot={slot} path={path} errors={errors} />}
      {value?.kind === 'RAW' && (
        <div className="formula">
          <Icon name="code" size={14} /> {exprSummary(value.json)}
        </div>
      )}
      {value?.kind !== 'EXPR' && <FieldErrors errors={mine} />}
    </div>
  );
}

/** A calculation shown as a ladder, or read-only when it has an expression on its left (not a ladder). */
/** A calculation drawn as steps. */
export function Calculation({ value, onChange, slot, path, errors }: { value: ExprOperand; onChange: (op: Operand) => void; slot?: TypeRef; path: string; errors: ValidationError[] }) {
  return <Ladder value={value} onChange={onChange} slot={slot} path={path} errors={errors} step={1} />;
}

/** How many steps a calculation draws (for numbering the steps after it). */
const stepCount = (op: Operand | null): number => (op?.kind === 'EXPR' ? 1 + stepCount(op.lhs) + (op.unary ? 0 : stepCount(op.rhs)) : 0);

/** One ladder step: LHS (constant | attribute) · operation · RHS; a "Calculate" RHS continues one step down. */
function Ladder({
  value,
  onChange,
  slot,
  path,
  errors,
  step,
}: {
  value: ExprOperand;
  onChange: (op: Operand) => void;
  slot?: TypeRef;
  path: string;
  errors: ValidationError[];
  step: number;
}) {
  const { attrs } = useEditor();
  const { trace } = useContext(TreeContext);
  const ran = stepOf(trace, path, 'CALCULATION');
  // New left sides are a constant or an attribute (the ladder rule); a rule saved with a saved expression or a
  // calculation on the left still shows it, the calculation as its own step below.
  const leftKinds: SlotKind[] = ['ATTRIBUTE', 'CONSTANT', ...(value.lhs?.kind === 'REF' ? (['REF'] as SlotKind[]) : []), ...(value.lhs?.kind === 'EXPR' ? (['EXPR'] as SlotKind[]) : [])];
  const lhsType = useOperandType(value.lhs);
  const resultType = useOperandType(value);
  const opsKey = lhsType ? `ops|${typeLabel(lhsType)}` : null;
  const ops = useAsync(opsKey, () => cached(opsKey!, () => api.operators(lhsType!)));
  const arithmetic = ops.data?.arithmetic ?? [];
  const names = [...new Set(arithmetic.map((o) => o.name))];
  const spec = arithmetic.find((o) => o.name === value.op);
  const set = (patch: Partial<ExprOperand>) => onChange({ ...value, ...patch });

  const changeLhs = (lhs: Operand | null) => {
    const next = leafType(lhs, attrs);
    const same = lhsType && next && typeLabel(lhsType) === typeLabel(next);
    set(same ? { lhs } : { lhs, op: '', unary: false, rhs: null }); // a new left type means new operations
  };
  const changeOp = (name: string) => {
    const next = arithmetic.find((o) => o.name === name);
    const unary = next ? next.rhs === null : false;
    let rhs = unary ? null : value.rhs;
    if (next?.rhs && rhs?.kind === 'CONSTANT' && typeLabel(constantType(rhs)) !== typeLabel(next.rhs)) rhs = { ...emptyConstant(next.rhs), value: rhs.value };
    set({ op: name, unary, rhs });
  };

  return (
    <div className="ladder">
      <div className={`lstep ${ran ? 'lstep-ran' : ''}`}>
        <span className="lstep-n" title={`Step ${step}`}>
          {step}
        </span>
        <div className="eq">
          <SlotPicker value={value.lhs} onChange={changeLhs} allow={leftKinds} constantType={slot} path={`${path}.lhs`} errors={errors} placeholder="Left value…" />
          <Dropdown
            variant="pill"
            className="eq-op"
            ariaLabel="Operation"
            value={value.op}
            disabled={!lhsType}
            onChange={changeOp}
            placeholder={lhsType ? 'op' : '…'}
            minMenuWidth={260}
            options={[
              ...(value.op && !names.includes(value.op) && !ops.loading ? [{ value: value.op, label: `${value.op} (not available)`, disabled: true }] : []),
              ...names.map((n) => ({ value: n, label: n.replace(/_/g, ' '), hint: arithmeticHint(n), short: arithmeticShort(n), icon: SYMBOL[n] })),
            ]}
          />
          {value.unary ? (
            <div className="eq-none">—</div>
          ) : value.op ? (
            <SlotPicker
              value={value.rhs}
              onChange={(rhs) => set({ rhs })}
              slot={spec?.rhs ?? undefined}
              allow={['ATTRIBUTE', 'CONSTANT', 'REF', 'EXPR']}
              path={`${path}.rhs`}
              errors={errors}
              placeholder="Right value…"
            />
          ) : (
            <div className="eq-none hint">{lhsType ? 'pick an operation' : 'pick the left value'}</div>
          )}
        </div>
        {ran && (
          <div className="ran-calc" title="What the last Calculate did here">
            {showValue(ran.lhs)} <b>{arithmeticShort(ran.operation ?? value.op)}</b>
            {ran.rhs !== undefined && ran.rhs !== null && <> {showValue(ran.rhs)}</>} = <strong>{showValue(ran.result)}</strong>
          </div>
        )}
        <FieldErrors errors={ownErrors(errors, path)} />
        {step === 1 && resultType && slot && typeLabel(resultType) !== typeLabel(slot) && (
          <div className="hint">Gives {typeLabel(resultType)}; this needs {typeLabel(slot)}</div>
        )}
      </div>
      {value.lhs?.kind === 'EXPR' && (
        <div className="lstep-sub lstep-left">
          <span className="lstep-from">left side of step {step}</span>
          <Ladder value={value.lhs} onChange={(lhs) => set({ lhs })} path={`${path}.lhs`} errors={errors} step={step + 1} />
        </div>
      )}
      {!value.unary && value.rhs?.kind === 'EXPR' && (
        <div className="lstep-sub lstep-next">
          <span className="lstep-from">right side of step {step}</span>
          <Ladder value={value.rhs} onChange={(rhs) => set({ rhs })} slot={spec?.rhs ?? undefined} path={`${path}.rhs`} errors={errors} step={step + 1 + stepCount(value.lhs)} />
        </div>
      )}
    </div>
  );
}

const leafType = (op: Operand | null, attrs: ReturnType<typeof useEditor>['attrs']) =>
  op?.kind === 'CONSTANT' ? constantType(op) : op?.kind === 'ATTRIBUTE' ? findAttribute(attrs, op.ref)?.type : undefined;

const SYMBOL: Record<string, string> = { add: '+', subtract: '−', multiply: '×', divide: '÷' };

/** The whole operand as one readable line, e.g. `market value × (0.01 + rate)`. */
export function OneLine({ value }: { value: Operand | null }) {
  const { attrs } = useEditor();
  return <>{formula(value, attrs)}</>;
}

export function formula(op: Operand | null, attrs: ReturnType<typeof useEditor>['attrs'], nested = false): string {
  if (!op) return '…';
  switch (op.kind) {
    case 'CONSTANT':
      return op.container === 'list' ? `[${op.items.join(', ')}]` : op.dataType === 'string' ? `"${op.value}"` : op.value || '…';
    case 'ATTRIBUTE':
      return op.ref ? findAttribute(attrs, op.ref)?.name ?? op.ref : '…';
    case 'REF':
      return op.key ? op.key.split(':').pop()! : '…';
    case 'EXPR': {
      if (!op.op) return formula(op.lhs, attrs, true) + ' …';
      const a = formula(op.lhs, attrs, true);
      if (op.unary) return `${op.op.replace(/_/g, ' ')}(${a})`;
      const b = formula(op.rhs, attrs, true);
      const text = SYMBOL[op.op] ? `${a} ${SYMBOL[op.op]} ${b}` : `${op.op.replace(/_/g, ' ')}(${a}, ${b})`;
      return nested && SYMBOL[op.op] ? `(${text})` : text;
    }
    default:
      return exprSummary(op.json);
  }
}
