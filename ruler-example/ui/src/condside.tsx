// One side (LHS or RHS) of a condition card, laid out as three aligned rows in its column of the card's grid:
//   row 1  what it is:          Attribute | Constant | Expression
//   row 2  attribute → its container + data type (locked)   constant → container + data type (chosen, or locked by the operator)
//          expression → which saved expression (by id)
//   row 3  attribute → which attribute   constant → the value   expression → its return container + data type (locked)
//   row 4  extras: dynamic params, description, last run's value, errors
import { useContext } from 'react';
import { typeLabel, type TypeRef, type ValidationError } from './api';
import { TreeContext } from './context';
import { Dropdown } from './dropdown';
import { useOperandType } from './expression';
import { attributeValue, emptyConstant, findAttribute, ownErrors, showValue, stepOf, type ConstantOperand, type Operand } from './model';
import { EnumSelect, ExpressionLink, FieldErrors, ListInput, ParamsEditor, ScalarInput, attributeOption, useEditor, useSlotAttributes } from './operand';
import { useSavedExpressions } from './slot';
import { Icon, Segmented } from './ui';

type SideKind = 'ATTRIBUTE' | 'CONSTANT' | 'REF' | 'EXPR';

const CONTAINERS = [
  { value: 'primitive', label: 'single value' },
  { value: 'list', label: 'list' },
];

export function ConditionSide({
  column,
  value,
  onChange,
  slot,
  choices,
  path,
  errors,
}: {
  column: 1 | 3;
  value: Operand | null;
  onChange: (op: Operand | null) => void;
  /** The type this side must be (RHS: what the operator needs); none on the LHS, which sets the type. */
  slot?: TypeRef;
  /** Enum values a constant must be one of (from the other side). */
  choices?: string[];
  path: string;
  errors: ValidationError[];
}) {
  const { attrs, dataTypes } = useEditor();
  const { trace } = useContext(TreeContext);
  const attrOptions = useSlotAttributes(slot) ?? [];
  const saved = useSavedExpressions(value?.kind === 'REF' ? (slot ?? undefined) : null);
  const resultType = useOperandType(value);
  const cell = (row: number) => ({ gridColumn: column, gridRow: row + 1 }); // grid row 1 holds the column headings
  const mine = ownErrors(errors, path);

  const kind = (value && value.kind !== 'RAW' ? value.kind : '') as SideKind | '';
  const pick = (k: SideKind) => {
    if (k === kind) return;
    if (k === 'ATTRIBUTE') onChange({ kind: 'ATTRIBUTE', ref: '', params: {} });
    else if (k === 'CONSTANT') onChange(emptyConstant(slot ?? { container_type: 'primitive', data_type: 'string' }));
    else if (k === 'REF') onChange({ kind: 'REF', key: '', version: 0 });
  };
  const kinds: { value: SideKind; label: string }[] = [
    { value: 'ATTRIBUTE', label: 'Attribute' },
    { value: 'CONSTANT', label: 'Constant' },
    { value: 'REF', label: 'Expression' },
    ...(kind === 'EXPR' ? [{ value: 'EXPR' as SideKind, label: 'Calculation' }] : []), // a saved rule with an inline calculation
  ];

  const meta = value?.kind === 'ATTRIBUTE' ? findAttribute(attrs, value.ref) : undefined;
  const refOf = (a: (typeof attrs)[number]) => (a.dynamic ? a.code : a.path!);
  const used = value?.kind === 'ATTRIBUTE' ? attributeValue(trace, value.ref) : value?.kind === 'REF' ? refResult(stepOf(trace, path, 'REFERENCE')) : { found: false };

  let row2: React.ReactNode = null;
  let row3: React.ReactNode = null;
  let extra: React.ReactNode = null;

  if (value?.kind === 'ATTRIBUTE') {
    row2 = <LockedType type={meta?.type} />;
    row3 = (
      <Dropdown
        ariaLabel="Attribute"
        value={meta ? refOf(meta) : value.ref}
        onChange={(ref) => onChange({ kind: 'ATTRIBUTE', ref, params: {} })}
        placeholder={attrOptions.length ? 'Select attribute…' : 'No attribute fits'}
        minMenuWidth={340}
        options={[
          ...attrOptions.filter((a) => !a.dynamic).map((a) => attributeOption(a, refOf(a), 'From the input')),
          ...attrOptions.filter((a) => a.dynamic).map((a) => attributeOption(a, refOf(a), 'Computed')),
        ]}
      />
    );
    extra = (
      <>
        {meta && (meta.type.enum_values?.length || meta.description) && (
          <div className="side-note">{meta.type.enum_values?.length ? `One of ${meta.type.enum_values.join(', ')}` : meta.description}</div>
        )}
        {meta?.dynamic && meta.params.length > 0 && <ParamsEditor params={meta.params} value={value.params} onChange={(params) => onChange({ ...value, params })} />}
      </>
    );
  } else if (value?.kind === 'CONSTANT') {
    const set = (patch: Partial<ConstantOperand>) => onChange({ ...value, ...patch });
    const enumChoices = choices ?? slot?.enum_values ?? undefined;
    row2 = slot ? (
      <LockedType type={{ container_type: value.container, data_type: slot.data_type === 'enum' ? 'enum' : value.dataType, enum_values: slot.enum_values }} />
    ) : (
      <div className="pair">
        <Dropdown
          ariaLabel="Container type"
          value={value.container}
          onChange={(c) => onChange({ ...emptyConstant({ container_type: c as 'primitive' | 'list', data_type: value.dataType }), value: value.value })}
          options={CONTAINERS}
        />
        <Dropdown
          ariaLabel="Data type"
          value={value.dataType}
          onChange={(t) => onChange({ ...emptyConstant({ container_type: value.container, data_type: t }), value: t === 'boolean' ? 'true' : '' })}
          options={dataTypes.filter((t) => t.name !== 'object' && t.name !== 'enum').map((t) => ({ value: t.name, label: t.name }))}
        />
      </div>
    );
    row3 =
      value.container === 'list' ? (
        <ListInput dataType={value.dataType} items={value.items} choices={enumChoices} onChange={(items) => set({ items })} />
      ) : enumChoices ? (
        <EnumSelect choices={enumChoices} value={value.value} onChange={(v) => set({ value: v })} label="Value" />
      ) : (
        <ScalarInput dataType={value.dataType} value={value.value} onChange={(v) => set({ value: v })} label="Value" />
      );
  } else if (value?.kind === 'REF') {
    const options = saved.data ?? [];
    const chosen = options.find((e) => e.key === value.key);
    row2 = (
      <Dropdown
        ariaLabel="Expression"
        value={value.key}
        onChange={(key) => {
          const e = options.find((x) => x.key === key)!;
          onChange({ kind: 'REF', key: e.key, version: e.version });
        }}
        placeholder={saved.loading ? 'Loading…' : options.length ? 'Select expression…' : 'No saved expression fits'}
        minMenuWidth={340}
        options={[
          ...(value.key && !chosen ? [{ value: value.key, label: `${value.key.split(':').pop()} (does not fit)`, disabled: true }] : []),
          ...options.map((e) => ({ value: e.key, label: e.name, meta: `v${e.version}`, hint: e.description ?? undefined, icon: <Icon name="code" size={13} /> })),
        ]}
      />
    );
    row3 = <LockedType type={chosen?.result_type ?? resultType} />;
    extra = (
      <>
        {value.key && <ExpressionLink refKey={value.key} version={value.version} />}
        {chosen && chosen.version !== value.version && (
          <button type="button" className="link" onClick={() => onChange({ ...value, version: chosen.version })}>
            Pinned to v{value.version} · use active v{chosen.version}
          </button>
        )}
      </>
    );
  } else if (value?.kind === 'EXPR') {
    row2 = <div className="locked-field">ƒ calculated below</div>;
    row3 = <LockedType type={resultType} />;
  }

  return (
    <>
      <div className="cside-cell" style={cell(1)}>
        <Segmented<SideKind | ''> size="sm" value={kind} onChange={(k) => k && pick(k)} options={kinds} />
      </div>
      {value ? (
        <>
          <div className="cside-cell" style={cell(2)}>
            {row2}
          </div>
          <div className={`cside-cell ${mine.length ? 'has-error' : ''}`} style={cell(3)}>
            {row3}
          </div>
        </>
      ) : (
        // nothing chosen yet: one placeholder over the type and value rows, like the right side before an operator
        <div className="cside-cell cside-wait" style={{ gridColumn: column, gridRow: '3 / 5' }}>
          {column === 1 ? 'Pick what to check' : 'Pick what to compare with'}
        </div>
      )}
      <div className="cside-cell cside-extra" style={cell(4)}>
        {used.found && <div className="ran-side" title="What the last Calculate used">= {showValue(used.value)}</div>}
        {extra}
        <FieldErrors errors={mine} />
      </div>
    </>
  );
}

const refResult = (s: { result: unknown } | undefined) => (s ? { found: true, value: s.result } : { found: false });

/** Container + data type side by side, read-only (set by the attribute, the expression or the operator). */
function LockedType({ type }: { type?: TypeRef | null }) {
  const container = type ? (type.container_type === 'primitive' ? 'single value' : type.container_type) : '—';
  const data = type ? (type.enum_values?.length ? `enum[${type.enum_values.join(', ')}]` : type.data_type) : '—';
  return (
    <div className="pair" title={type ? typeLabel(type) : 'Set when you pick it'}>
      <div className="locked-field">
        <Icon name="lock" size={12} />
        {container}
      </div>
      <div className="locked-field">
        <Icon name="lock" size={12} />
        {data}
      </div>
    </div>
  );
}
