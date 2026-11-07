import { describe, expect, it } from 'vitest';
import type { AttributeView } from './api';
import {
  findAttribute,
  samePath,
  attributeValue,
  buildTrace,
  rowValue,
  showValue,
  stepOf,
  visited,
  exprDraftFromJson,
  exprDraftToJson,
  isLadder,
  rowPath,
  assignErrors,
  childPath,
  draftFromJson,
  draftToJson,
  emptyCondition,
  emptyValue,
  nodeComplete,
  nodePaths,
  nodeToJson,
  operandFromJson,
  operandComplete,
  operandToJson,
  ownErrors,
  parseSample,
  replaceAt,
  sampleSkeleton,
  reshapeValues,
  treeProblems,
  type ConditionNode,
  type ConstantOperand,
  type Operand,
  type ValueNode,
} from './model';

// The seeded stamp-duty:default tree (ruler-example/src/main/resources/seed/stamp-duty-rules.yml), as the API returns it.
const ref = (key: string) => ({ type: 'EXPRESSION_REFERENCE', value: key, version: 1 });
const entries = (fee: string) => ({
  stamp_duty: ref('stamp-duty:stamp_duty'),
  registration_fee: ref(fee),
  total_payable: { type: 'EXPRESSION', operation: 'add', lhs: ref('stamp-duty:stamp_duty'), rhs: ref(fee) },
});
const SEED = {
  case: 'stamp-duty',
  name: 'default',
  description: 'Stamp duty, registration fee and total payable, by state',
  returns: { container_type: 'map', key_type: 'string', data_type: 'big_decimal', scale: 2, rounding: 'HALF_UP' },
  root: {
    type: 'condition',
    description: 'Maharashtra caps the registration fee; Karnataka does not',
    lhs: { type: 'ATTRIBUTE', value: 'property.state' },
    operator: 'equals',
    rhs: { type: 'CONSTANT', value: 'MH' },
    success_condition: { type: 'value', entries: entries('stamp-duty:mh_registration_fee') },
    failure_condition: { type: 'value', entries: entries('stamp-duty:ka_registration_fee') },
  },
};

const RATE: AttributeView = {
  name: 'stamp duty rate',
  code: 'stamp_duty_rate',
  description: null,
  dynamic: true,
  path: null,
  type: { container_type: 'primitive', data_type: 'big_decimal' },
  params: [
    { name: 'state', description: null, type: { container_type: 'primitive', data_type: 'string' }, required: true, default_value: null, min: null, max: null, allowed_values: ['MH', 'KA'], pattern: null },
    { name: 'area_type', description: null, type: { container_type: 'primitive', data_type: 'string' }, required: false, default_value: 'URBAN', min: null, max: null, allowed_values: [], pattern: null },
    { name: 'woman_buyer', description: null, type: { container_type: 'primitive', data_type: 'boolean' }, required: false, default_value: false, min: null, max: null, allowed_values: [], pattern: null },
  ],
};

describe('UI1 round trip', () => {
  it('writes the seeded tree back unchanged', () => {
    expect(draftToJson(draftFromJson(SEED), [])).toEqual(SEED);
  });

  it('keeps unedited parts when one field changes', () => {
    const d = draftFromJson(SEED);
    const root = d.root as ConditionNode;
    const edited = draftToJson({ ...d, root: { ...root, operator: 'not_equals' } }, []);
    expect(edited.root.operator).toBe('not_equals');
    expect(edited.root.success_condition).toEqual(SEED.root.success_condition);
    expect(edited.root.rhs).toEqual(SEED.root.rhs);
  });
});

describe('UI2 paths', () => {
  it('TRUE is success_condition, FALSE is failure_condition', () => {
    expect(childPath('$.root', 'success')).toBe('$.root.success_condition');
    expect(childPath('$.root', 'failure')).toBe('$.root.failure_condition');
    expect(nodePaths(draftFromJson(SEED).root)).toEqual(['$.root', '$.root.failure_condition', '$.root.success_condition']);
  });

  it('replaceAt edits and removes nested nodes', () => {
    const root = { ...emptyCondition(), success: emptyCondition() };
    const v = emptyValue('primitive');
    const added = replaceAt(root, '$.root.success_condition.failure_condition', v) as ConditionNode;
    expect((added.success as ConditionNode).failure).toBe(v);
    expect(added.failure).toBeNull();
    const removed = replaceAt(added, '$.root.success_condition', null) as ConditionNode;
    expect(removed.success).toBeNull();
    expect(replaceAt(added, '$.root', null)).toBeNull();
  });
});

describe('UI3 error mapping', () => {
  const paths = ['$.root', '$.root.success_condition'];
  it('assigns to the deepest owning node; missing branches to the parent; others to the tree', () => {
    const e = (path: string) => ({ path, code: 'X', message: path });
    const { byNode, tree } = assignErrors(
      [e('$.root.success_condition.lhs'), e('$.root.operator'), e('$.root.failure_condition'), e('$.returns'), e('$.root.success_condition.items[1]')],
      paths,
    );
    expect(byNode.get('$.root.success_condition')!.map((x) => x.path)).toEqual(['$.root.success_condition.lhs', '$.root.success_condition.items[1]']);
    expect(byNode.get('$.root')!.map((x) => x.path)).toEqual(['$.root.operator', '$.root.failure_condition']);
    expect(tree.map((x) => x.path)).toEqual(['$.returns']);
  });
});

describe('UI4 constants', () => {
  it('serialise with explicit types; numbers as exact strings; booleans as booleans; lists as arrays', () => {
    expect(operandToJson({ kind: 'CONSTANT', container: 'primitive', dataType: 'big_decimal', value: '0.10', items: [] })).toEqual({
      type: 'CONSTANT', container_type: 'primitive', data_type: 'big_decimal', value: '0.10',
    });
    expect(operandToJson({ kind: 'CONSTANT', container: 'primitive', dataType: 'boolean', value: 'false', items: [] }).value).toBe(false);
    expect(operandToJson({ kind: 'CONSTANT', container: 'list', dataType: 'string', value: '', items: ['MH', 'KA'] })).toEqual({
      type: 'CONSTANT', container_type: 'list', data_type: 'string', value: ['MH', 'KA'],
    });
  });

  it('infers the type of an untyped loaded constant', () => {
    expect(operandFromJson({ type: 'CONSTANT', value: true })).toMatchObject({ dataType: 'boolean', value: 'true' });
    expect(operandFromJson({ type: 'CONSTANT', value: 5 })).toMatchObject({ dataType: 'integer', value: '5' });
    expect(operandFromJson({ type: 'CONSTANT', value: ['a'] })).toMatchObject({ container: 'list', items: ['a'] });
  });
});

describe('UI5 attributes', () => {
  it('dynamic: code + typed params; an empty optional param is omitted', () => {
    const json = operandToJson(
      { kind: 'ATTRIBUTE', ref: 'stamp_duty_rate', params: { state: { source: 'CONSTANT', value: 'MH' }, area_type: { source: 'CONSTANT', value: '' }, woman_buyer: { source: 'ATTRIBUTE', ref: 'buyer.is_woman' } } },
      [RATE],
    );
    expect(json).toEqual({
      type: 'ATTRIBUTE',
      value: 'stamp_duty_rate',
      params: [
        { name: 'state', type: 'CONSTANT', container_type: 'primitive', data_type: 'string', value: 'MH' },
        { name: 'woman_buyer', type: 'ATTRIBUTE', value: 'buyer.is_woman' },
      ],
    });
  });

  it('static: just the path', () => {
    expect(operandToJson({ kind: 'ATTRIBUTE', ref: 'property.state', params: {} })).toEqual({ type: 'ATTRIBUTE', value: 'property.state' });
  });
});

describe('UI6 completeness', () => {
  it('a card is complete only when every part is filled', () => {
    const c = emptyCondition();
    expect(nodeComplete(c)).toBe(false);
    const filled: ConditionNode = { ...c, lhs: { kind: 'ATTRIBUTE', ref: 'property.state', params: {} }, operator: 'equals', rhs: { kind: 'CONSTANT', container: 'primitive', dataType: 'string', value: 'MH', items: [] } };
    expect(nodeComplete(filled)).toBe(true);
    expect(nodeComplete({ ...filled, rhs: { kind: 'CONSTANT', container: 'list', dataType: 'string', value: '', items: ['MH', ''] } })).toBe(false);
    const map = emptyValue('map');
    expect(nodeComplete(map)).toBe(false);
    expect(nodeComplete({ ...map, rows: [{ id: 'r', key: 'k', value: filled.rhs }] })).toBe(true);
    expect(nodeComplete({ ...map, rows: [{ id: 'r', key: 'k', value: filled.rhs }, { id: 's', key: ' k', value: filled.rhs }] })).toBe(false); // duplicate key
  });

  it('treeProblems lists missing branches and unfilled cards', () => {
    expect(treeProblems(null)).toEqual(['The tree is empty']);
    expect(treeProblems(emptyCondition())).toEqual(['Root is not filled in', 'Root has no FALSE branch', 'Root has no TRUE branch']);
    expect(treeProblems(draftFromJson(SEED).root)).toEqual([]);
  });

  it('validate-node body has no children', () => {
    const json = nodeToJson(draftFromJson(SEED).root!, [], false);
    expect(json.success_condition).toBeUndefined();
    expect(json.failure_condition).toBeUndefined();
  });
});

describe('UI7 return type change', () => {
  it('value nodes take the new empty shape; conditions are kept', () => {
    const root = draftFromJson(SEED).root as ConditionNode;
    const next = reshapeValues(root, 'list') as ConditionNode;
    expect(next.lhs).toBe(root.lhs);
    expect((next.success as ValueNode).shape).toBe('list');
    expect((next.success as ValueNode).rows).toHaveLength(1);
  });
});

describe('UI17 list-typed and enum params', () => {
  const LIST_PARAM: AttributeView = {
    ...RATE,
    params: [{ ...RATE.params[0], name: 'states', type: { container_type: 'list', data_type: 'string' } }],
  };
  it('a list param is sent as an array, empty rows dropped; loading it back gives the same items', () => {
    const json = operandToJson({ kind: 'ATTRIBUTE', ref: 'stamp_duty_rate', params: { states: { source: 'CONSTANT', value: '', items: ['MH', '', 'KA'] } } }, [LIST_PARAM]);
    expect(json.params).toEqual([{ name: 'states', type: 'CONSTANT', container_type: 'list', data_type: 'string', value: ['MH', 'KA'] }]);
    expect(operandFromJson(json)).toMatchObject({ params: { states: { source: 'CONSTANT', items: ['MH', 'KA'] } } });
  });
  it('an enum param is sent as a plain string (the server checks it is a member)', () => {
    const enumRate: AttributeView = { ...RATE, params: [{ ...RATE.params[0], type: { container_type: 'primitive', data_type: 'enum', enum_values: ['MH', 'KA'] } }] };
    const json = operandToJson({ kind: 'ATTRIBUTE', ref: 'stamp_duty_rate', params: { state: { source: 'CONSTANT', value: 'MH' } } }, [enumRate]);
    expect(json.params[0]).toEqual({ name: 'state', type: 'CONSTANT', container_type: 'primitive', data_type: 'string', value: 'MH' });
  });
  it('an empty list param is omitted (server default applies)', () => {
    const json = operandToJson({ kind: 'ATTRIBUTE', ref: 'stamp_duty_rate', params: { states: { source: 'CONSTANT', value: '', items: [''] } } }, [LIST_PARAM]);
    expect(json.params).toBeUndefined();
  });
});

describe('UI18 sample input', () => {
  const attr = (path: string, data_type: string, extra: Partial<AttributeView> = {}): AttributeView => ({
    name: path, code: path, description: null, dynamic: false, path, type: { container_type: 'primitive', data_type }, params: [], ...extra,
  });
  it('template follows static paths (nested, index, wildcard); enum attributes use their first allowed value; dynamic ones are skipped', () => {
    expect(
      sampleSkeleton([
        attr('property.state', 'enum', { type: { container_type: 'primitive', data_type: 'enum', enum_values: ['MH', 'KA'] } }),
        attr('property.agreement_value', 'big_decimal'),
        attr('buyer.is_woman', 'boolean'),
        attr('owners.*.name', 'string'),
        attr('owners.0.age', 'integer'),
        RATE,
      ]),
    ).toEqual({ property: { state: 'MH', agreement_value: 0 }, buyer: { is_woman: false }, owners: [{ name: '', age: 0 }] });
  });
  it('must be a JSON object', () => {
    expect(parseSample('').error).toMatch(/required/);
    expect(parseSample('{bad').error).toMatch(/Not valid JSON/);
    expect(parseSample('[1]').error).toMatch(/JSON object/);
    expect(parseSample('{"a":1}')).toEqual({ value: { a: 1 } });
  });
  it('a loaded version keeps its stored sample', () => {
    expect(JSON.parse(draftFromJson(SEED, { property: { state: 'KA' } }).sample)).toEqual({ property: { state: 'KA' } });
    expect(draftFromJson(SEED).sample).toBe('');
  });
});

describe('UI23 value expressions', () => {
  const ref: Operand = { kind: 'REF', key: 'stamp-duty:chargeable_value', version: 1 };
  const pct: ConstantOperand = { kind: 'CONSTANT', container: 'primitive', dataType: 'big_decimal', value: '0.01', items: [] };
  it('saved expression → EXPRESSION_REFERENCE pinned to its version', () => {
    expect(operandToJson(ref)).toEqual({ type: 'EXPRESSION_REFERENCE', value: 'stamp-duty:chargeable_value', version: 1 });
  });
  it('nested calculation → EXPRESSION tree; a unary one has no rhs', () => {
    const json = operandToJson({
      kind: 'EXPR', op: 'min', unary: false,
      lhs: { kind: 'EXPR', op: 'multiply', unary: false, lhs: ref, rhs: pct },
      rhs: { ...pct, value: '30000' },
    });
    expect(json).toEqual({
      type: 'EXPRESSION', operation: 'min',
      lhs: { type: 'EXPRESSION', operation: 'multiply', lhs: { type: 'EXPRESSION_REFERENCE', value: 'stamp-duty:chargeable_value', version: 1 }, rhs: { type: 'CONSTANT', container_type: 'primitive', data_type: 'big_decimal', value: '0.01' } },
      rhs: { type: 'CONSTANT', container_type: 'primitive', data_type: 'big_decimal', value: '30000' },
    });
    expect(operandToJson({ kind: 'EXPR', op: 'sum', unary: true, lhs: { kind: 'ATTRIBUTE', ref: 'prices', params: {} }, rhs: null })).toEqual({
      type: 'EXPRESSION', operation: 'sum', lhs: { type: 'ATTRIBUTE', value: 'prices' },
    });
  });
  it('loads EXPRESSION / EXPRESSION_REFERENCE as editable operands', () => {
    const e = operandFromJson({ type: 'EXPRESSION', operation: 'add', lhs: { type: 'EXPRESSION_REFERENCE', value: 'k', version: 2 }, rhs: { type: 'CONSTANT', value: 1 } });
    expect(e).toMatchObject({ kind: 'EXPR', op: 'add', unary: false, lhs: { kind: 'REF', key: 'k', version: 2 }, rhs: { kind: 'CONSTANT' } });
    expect(operandFromJson({ type: 'EXPRESSION', operation: 'lower_case', lhs: { type: 'ATTRIBUTE', value: 'a' } })).toMatchObject({ unary: true, rhs: null });
  });
  it('complete only when every part is set', () => {
    expect(operandComplete({ kind: 'REF', key: '', version: 0 })).toBe(false);
    expect(operandComplete({ kind: 'EXPR', op: 'add', unary: false, lhs: ref, rhs: null })).toBe(false);
    expect(operandComplete({ kind: 'EXPR', op: 'add', unary: false, lhs: ref, rhs: pct })).toBe(true);
    expect(operandComplete({ kind: 'EXPR', op: 'sum', unary: true, lhs: ref, rhs: null })).toBe(true);
    expect(operandComplete({ kind: 'EXPR', op: '', unary: false, lhs: ref, rhs: pct })).toBe(false);
  });
  it('an error shows on the node it belongs to, not on its parents', () => {
    const errs = [{ path: '$.v', code: 'A', message: '' }, { path: '$.v.lhs', code: 'B', message: '' }, { path: '$.v.lhs.rhs', code: 'C', message: '' }];
    expect(ownErrors(errs, '$.v').map((e) => e.code)).toEqual(['A']);
    expect(ownErrors(errs, '$.v.lhs').map((e) => e.code)).toEqual(['B']);
  });
});

describe('UI26 map entries are a JSON object (lld §19)', () => {
  it('reads and writes {key: expression}; row paths are entries.<key>', () => {
    const v = draftFromJson(SEED).root as ConditionNode;
    const success = v.success as ValueNode;
    expect(success.rows.map((r) => r.key)).toEqual(['stamp_duty', 'registration_fee', 'total_payable']);
    expect(rowPath('$.root.success_condition', success, 2)).toBe('$.root.success_condition.entries.total_payable');
    const edited = nodeToJson({ ...success, rows: [{ ...success.rows[0], key: ' duty ' }] }, []);
    expect(edited.entries).toEqual({ duty: SEED.root.success_condition.entries.stamp_duty });
  });
  it('a key used twice blocks saving', () => {
    const v = { ...emptyValue('map'), rows: [{ id: 'a', key: 'x', value: { kind: 'REF', key: 'k', version: 1 } }, { id: 'b', key: 'x', value: { kind: 'REF', key: 'k', version: 1 } }] } as ValueNode;
    expect(treeProblems(v)).toContain('Root uses key "x" twice');
  });
});

describe('UI27 ladder + expression drafts', () => {
  const c = (v: string): Operand => ({ kind: 'CONSTANT', container: 'primitive', dataType: 'integer', value: v, items: [] });
  const a: Operand = { kind: 'ATTRIBUTE', ref: 'x', params: {} };
  it('left side must be a constant or attribute at every step; the right side chains', () => {
    expect(isLadder({ kind: 'EXPR', op: 'add', unary: false, lhs: a, rhs: { kind: 'EXPR', op: 'multiply', unary: false, lhs: c('2'), rhs: { kind: 'REF', key: 'k', version: 1 } } })).toBe(true);
    expect(isLadder({ kind: 'EXPR', op: 'min', unary: false, lhs: { kind: 'EXPR', op: 'add', unary: false, lhs: a, rhs: c('1') }, rhs: c('3') })).toBe(false);
    expect(isLadder({ kind: 'EXPR', op: 'add', unary: false, lhs: { kind: 'REF', key: 'k', version: 1 }, rhs: c('1') })).toBe(false);
    expect(isLadder(a)).toBe(true);
  });
  it('expression definition round-trips with returns', () => {
    const json = { case: 'stamp-duty', name: 'fee', returns: { container_type: 'primitive', data_type: 'big_decimal', scale: 2 }, expression: { type: 'EXPRESSION', operation: 'multiply', lhs: { type: 'ATTRIBUTE', value: 'property.market_value' }, rhs: { type: 'CONSTANT', container_type: 'primitive', data_type: 'big_decimal', value: '0.01' } } };
    expect(exprDraftToJson(exprDraftFromJson(json, { a: 1 }), [])).toEqual(json);
    expect(JSON.parse(exprDraftFromJson(json, { a: 1 }).sample)).toEqual({ a: 1 });
  });
});

describe('UI31 run trace (explain=true, lld §22)', () => {
  // trimmed from a real run of stamp-duty:default with state MH
  const steps = [
    { kind: 'CONDITION', path: '$.root', operation: 'equals', lhs: 'MH', rhs: 'MH', result: true },
    { kind: 'CALCULATION', path: '$.root.success_condition.entries.stamp_duty(stamp-duty:stamp_duty@1)', operation: 'multiply', lhs: 12000000, rhs: 0.06, result: 720000 },
    { kind: 'REFERENCE', path: '$.root.success_condition.entries.stamp_duty', description: 'stamp-duty:stamp_duty@1', result: 720000 },
    { kind: 'CALCULATION', path: '$.root.success_condition.entries.total_payable', operation: 'add', lhs: 720000, rhs: 30000, result: 750000 },
    { kind: 'VALUE', path: '$.root.success_condition', result: { stamp_duty: 720000, registration_fee: 30000, total_payable: 750000 } },
  ] as any[];
  const trace = buildTrace(steps, [
    { code: 'state', path: 'property.state', value: 'MH' },
    { code: 'stamp_duty_rate', params: { state: 'MH' }, value: 0.06 },
  ]);
  it('keeps steps by node path, without the steps inside a saved expression', () => {
    expect(stepOf(trace, '$.root', 'CONDITION')?.result).toBe(true);
    expect(stepOf(trace, '$.root.success_condition.entries.stamp_duty', 'REFERENCE')?.result).toBe(720000);
    expect([...trace.steps.keys()].some((p) => p.includes('('))).toBe(false);
  });
  it('knows which nodes ran', () => {
    expect(visited(trace, '$.root')).toBe(true);
    expect(visited(trace, '$.root.success_condition')).toBe(true);
    expect(visited(trace, '$.root.failure_condition')).toBe(false);
    expect(visited(null, '$.root')).toBe(false);
  });
  it('gives each value row its result (map entries by key)', () => {
    const node = draftFromJson(SEED).root as ConditionNode;
    const v = node.success as ValueNode;
    expect(rowValue(trace, '$.root.success_condition', v, 2)).toEqual({ found: true, value: 750000 });
    expect(rowValue(trace, '$.root.failure_condition', node.failure as ValueNode, 0)).toEqual({ found: false });
  });
  it('attribute values by path (with or without $.) and dynamic ones by code', () => {
    expect(attributeValue(trace, '$.property.state')).toEqual({ found: true, value: 'MH' });
    expect(attributeValue(trace, 'stamp_duty_rate')).toEqual({ found: true, value: 0.06 });
    expect(attributeValue(trace, 'buyer.is_woman').found).toBe(false);
  });
  it('shows values for people', () => {
    expect(showValue('MH')).toBe('"MH"');
    expect(showValue(true)).toBe('true');
    expect(showValue([1, 2])).toBe('[1,2]');
  });
});

describe('UI32 "$." paths (lld §21)', () => {
  it('a path with or without "$." is the same attribute', () => {
    expect(samePath('$.loan_amount', 'loan_amount')).toBe(true);
    expect(samePath('parties.*.id', '$.parties.*.id')).toBe(true);
    expect(samePath('a.b', 'a.c')).toBe(false);
    expect(findAttribute([RATE, { ...RATE, name: 'loan amount', code: 'loan_amount', dynamic: false, path: 'loan_amount', params: [] }], '$.loan_amount')?.code).toBe('loan_amount');
  });
});

describe('UI35 a value node is laid out by its own JSON, not by the return type', () => {
  // stamp-duty-v2:distinct-states returns list<string> from ONE saved expression
  const TREE = {
    case: 'stamp-duty-v2',
    name: 'distinct-states',
    returns: { container_type: 'list', data_type: 'string' },
    root: { type: 'value', value: { type: 'EXPRESSION_REFERENCE', value: 'stamp-duty-v2:distinct_states', version: 1 } },
  };
  it('"value" stays one expression (not zero list rows) and round-trips unchanged', () => {
    const d = draftFromJson(TREE);
    const v = d.root as ValueNode;
    expect(v.shape).toBe('primitive');
    expect(v.single).toMatchObject({ kind: 'REF', key: 'stamp-duty-v2:distinct_states' });
    expect(draftToJson(d, [])).toEqual(TREE); // before the fix this became {"items": []}
  });
  it('its result is the whole returned list', () => {
    const trace = buildTrace([{ kind: 'VALUE', path: '$.root', result: ['MH', 'KA'] } as any]);
    expect(rowValue(trace, '$.root', draftFromJson(TREE).root as ValueNode, null)).toEqual({ found: true, value: ['MH', 'KA'] });
  });
  it('"items" / "entries" still build element by element', () => {
    expect((draftFromJson({ ...TREE, root: { type: 'value', items: [{ type: 'CONSTANT', value: 'MH' }] } }).root as ValueNode).shape).toBe('list');
    expect((nodeFromJsonShape({ type: 'value', entries: { a: { type: 'CONSTANT', value: 'x' } } }))).toBe('map');
  });
});
const nodeFromJsonShape = (json: any) => (draftFromJson({ case: 'c', name: 'n', returns: { container_type: 'map', data_type: 'string' }, root: json }).root as ValueNode).shape;
