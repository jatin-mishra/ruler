# Ruler — Low Level Design (v2 draft)

> Source: `prompts/prompt-1.md` plus review answers. §0 lists every decision. Rows marked ⚠ are interpretations of your answers that need a quick confirmation.

**Notation**
```
ClassName «kind»                 — responsibility
- field : Type                   [how / when used]
+ method(args) : Return          [caller → how / when]   (only listed when non-obvious)
```
`«record»` = immutable Java record, `«sealed»` = sealed interface, `«spi»` = interface the host service may implement.

---

## 0. Decisions

| # | Topic | Decision |
|---|---|---|
| Q1a | Config source | The host service owns the config, under the `ruler` prefix. Core: `RulerConfigSource` with options A (map) and B (yaml/properties readers). The Spring module binds `ruler.*` from the host's `application.yml` (§4.0). |
| Q1b | JSON | The core uses the `JsonCodec` SPI, implemented with Jackson. The domain never imports Jackson. |
| Q2 | Data types | Config-driven `DataTypeRegistry` (built-ins + host types), chosen per case (§2). |
| Q3 | Identity | `key = <case>:<name>` + a separate `version` column; **(key, version) is unique** (same for trees and expressions). The storage decides how: in DynamoDB, key = partition key and version = sort key; in an RDBMS, a composite unique key `(key, version)`. `EXPRESSION_REFERENCE` = `{value: <key>, version: <n>}`. |
| Q4 | Expression lifecycle | **Same lifecycle as decision trees**: DRAFT → approve → ACTIVE → INACTIVE, reject, markInactive, reactivate. Both use one shared `VersionLifecycle` (§9). |
| Q5 | Static `ATTRIBUTE.value` | It is a **path into the input**. On save, the path must match a static attribute in the case config, which gives the declared type ⚠ (pending: Q5b). On **approve**, the caller sends a **sample input**: every static path used is resolved against it and its runtime container and data type are checked against the declared type. A mismatch → 400 with the list of errors; the version **stays DRAFT** until it is approved or rejected. Dynamic attributes are **not** executed during this check (they may have side effects). |
| Q5c | Reject | DRAFT → INACTIVE. `remarks` is **mandatory** (the rejection reason) and is stored on the version and on its status transition. |
| Q5d | Reference status | An `EXPRESSION_REFERENCE` must point to an ACTIVE version when saved. After that it stays pinned and keeps working even if that version later becomes INACTIVE. |
| Q6 | Params + UI APIs | `ParamDefinition` constraints, `ParamBinding` values. UI APIs: `getAttributes`, `getAttributeParams`, `getExpressions`, `getOperators(container, dataType)` (§4.2). |
| Q7 | Validation scope | **Condition**: the operator is valid for the lhs type, and the rhs container and data types are compatible with that operator. **Expression**: the lhs and rhs result types are computed bottom-up and an executable operator must exist for them. **Tree**: every branch is checked and every leaf type must match the tree's return type. No contradiction detection. |
| Q20 | Return type | **Chosen per decision tree in the UI**, not in config: the tree definition carries `returns: {container_type, data_type, key_type, scale, rounding}`. A case only lists attributes. ⚠ The return type is locked after v1 (an update that changes it is rejected), because callers depend on it; a different return type means a new tree name. |
| Q8 | Missing attribute at runtime | Fail: throw `EvaluationException` with the node path. |
| Q9 | Hooks | They fire for **both kinds** (trees and expressions). ⚠ The spec's DT-only names are generalised: `PostCreationHook` (put), `PostPatchHook` (patch / reactivate), `InactiveMarkingHook` (markInactive), each receiving a `LifecycleEvent` with a `kind` field so a hook can filter. Approval fires no hook. |
| Q10 | Version number on update | The new version is always `latest + 1`. |
| Q11 | Reactivate an INACTIVE version | Allowed. Its data is copied into a **new latest DRAFT** version; the old version is not changed. The normal approval then applies. |
| Q12 | API layer | **Spring Boot web** in a separate starter module. The core stays vanilla Java (§1, §10). |
| Q13 | Wildcard | At most **one** `*` per path. This is checked at config load and on save. |
| Q14 | Update format | **Full data replacement.** The UI calls get → edits → sends the whole `data`. No merge patch. |
| Q15 | `getDecisionTree(case, name)` | Returns the **ACTIVE** version, otherwise `NotFoundException`. A specific version is available with `version`, and all versions with `history`. Expressions behave the same way. |
| Q16 | Cache | **None in v1.** Every evaluation loads from the repository. The code marks the cache extension point. |
| Q17 | Condition operands | Constant + Attribute only. A validator setting rejects Expression operands. |
| Q18 | Hook execution | **Synchronous, on the caller's thread, after a successful write.** Each hook runs inside try/catch with the error logged, so a hook can never fail the operation. A `// TODO` notes moving hooks to an executor. |
| Q19 | Java / Spring | Java 21 LTS through the Gradle toolchain. Spring Boot **4.0.x**; core uses **Jackson 3** to match. |

Design choices that answer spec §13 ("consider a better approach"):
1. **Single operator registry** used by validation, evaluation and the operators UI API, so the three cannot drift apart.
2. **One generic version lifecycle** shared by decision trees and expressions, instead of two copies of the same state machine.
3. **Atomicity lives in the repository contract** (`approve(...)` is one atomic call). There is no generic transaction abstraction.

---

## 1. Modules & architecture

```
ruler (Gradle multi-module)
├── ruler-core                 pure Java 21 + Jackson (JsonCodec impl only)
└── ruler-spring-boot-starter  Spring Boot web: auto-config, property binding, REST controllers
```

```
        HTTP ─▶ ┌─────────────────────────── ruler-spring-boot-starter ─────────────────────┐
                │ ExpressionController  DecisionTreeController  EvaluationController       │
                │ CatalogController     RulerExceptionHandler   RulerAutoConfiguration     │
                └───────────────┬──────────────────────────────────────────────────────────┘
 host code (direct calls) ─────▼                                      ruler-core
                ┌──────────────────────────────────────────────────────────────────────────┐
                │ service/  ExpressionService  DecisionTreeService  EvaluationService      │
                │           CatalogService     VersionLifecycle                            │
                └──┬───────────┬──────────────┬──────────────┬─────────────────────────────┘
                   ▼           ▼              ▼              ▼
              validation/    eval/       persistence/      hook/
                   └─────┬─────┘
                         ▼
             operator/  attribute/  config/        codec/
                         ▼
                      model/   (pure records, zero deps)
```
Dependencies point **downward only**. The core has no Spring dependency, so non-Spring hosts call the services directly.

```
io.ruler (ruler-core)
├── Ruler                 bootstrap facade + builder
├── service/              public service methods + VersionLifecycle
├── model/                DataType(+Registry), TypeRef, NumericContext, operands, nodes, definitions, Actor, Status
├── config/               RulerConfigSource(s), CaseDefinition, AttributeDefinition, ParamDefinition, CaseConfigLoader, CaseRegistry
├── attribute/            DynamicAttribute, AttributeFactory, PathResolver, AttributeResolver, ValueCoercer
├── operator/             OperatorRegistry, ConditionOperatorSpec, ArithmeticOperatorSpec, BuiltInOperators
├── validation/           TreeValidator, ValidationEngine, OperandTypeChecker, *Validator, SampleInputValidator
├── eval/                 Evaluator, OperandEvaluator, EvalContext, EvaluationResult
├── persistence/          VersionedRecord, StatusTransition, repositories (SPI), inmemory/
├── hook/                 PostCreationHook, PostPatchHook, InactiveMarkingHook, LifecycleEvent, HookDispatcher
├── codec/                JsonCodec, JacksonCodec, DefinitionParser, DefinitionWriter
└── error/                RulerException hierarchy

io.ruler.spring (ruler-spring-boot-starter)
├── RulerAutoConfiguration, RulerProperties, ActorResolver
└── web/                  4 controllers + RulerExceptionHandler + request/response DTOs
```

---

## 2. Type system (`model`)

Types are **config-driven**: each case picks its return and attribute types by name.

```
ContainerType «enum»             PRIMITIVE | LIST | MAP

DataType «record»                — a named data type that config refers to
- name      : String             ["double", "big_decimal" … the exact string used in YAML/JSON]
- javaType  : Class<?>           [runtime representation; result values are always this class]
- numeric   : boolean            [enables the numeric operator family + promotion]
- coercer   : Function<Object,Object>   [raw value → javaType; e.g. Short→Integer, Number→BigDecimal]

DataTypeRegistry                 — built-ins + host types, frozen at build()
- types : Map<String, DataType>
+ get(name) : DataType           [TypeRef.parse → unknown name = ConfigurationException / ValidationError]
+ promote(a, b) : Optional<DataType>
      [OperatorRegistry → integer→long→double, integer/long→big_decimal;
       double↔big_decimal is never implicit (precision), so mixing them is a validation error]

Built-ins:  string→String  integer→Integer  long→Long  double→Double  big_decimal→BigDecimal
            boolean→Boolean  object→Object (no arithmetic)
Extension:  builder.dataType(new DataType("date", LocalDate.class, false, coercer)) + its operators

TypeRef «record»                 — static type of any operand, attribute, node or return value
- container : ContainerType
- dataType  : DataType           [LIST/MAP: element (value) type]
- keyType   : DataType           [MAP only, else null]
+ parse(container, data, registry) : TypeRef   [CaseConfigLoader, DefinitionParser]
+ isAssignableTo(TypeRef) : boolean       [validators → exact match, or a widening allowed by registry.promote]
+ typeOfRuntime(Object value) : boolean    [SampleInputValidator → does this runtime value fit the type?]

NumericContext «record»          — big_decimal arithmetic settings
- divisionScale : int            [default 10; config `ruler.math.division-scale`]
- rounding      : RoundingMode   [default HALF_EVEN; config `ruler.math.rounding`]
                                 [big_decimal divide; a tree's `returns` may set scale/rounding for the final value]
```

---

## 3. Domain model (`model`)

### 3.1 Operands — shared by conditions, value nodes and expressions
```
Operand «sealed»                 permits Constant, AttributeRef, Expression, ExpressionRef

Constant «record»
- type  : TypeRef                [from JSON container_type/data_type]
- value : Object                 [coerced to type.dataType.javaType (or a List/Map of it) at parse time]

AttributeRef «record»            [Q5]
- value  : String                [static → input path, e.g. "loan_details.amount"; dynamic → attribute code]
- params : List<ParamBinding>    [dynamic only]
- type   : TypeRef               [optional in JSON; if given it must equal the declared type]

ParamBinding «record»            [Q6] — the value the UI user entered for one param
- name  : String                 [must match ParamDefinition.name]
- value : Operand                [JSON: {name, type: CONSTANT|ATTRIBUTE, container_type, data_type, value};
                                  Constant or static AttributeRef; validated against the ParamDefinition constraints]

Expression «record»
- op  : String                   [arithmetic op name → OperatorRegistry]
- lhs : Operand
- rhs : Operand                  [null for unary ops, e.g. lower_case]

ExpressionRef «record»          JSON: {"type": "EXPRESSION_REFERENCE", "value": "<case>:<name>", "version": 3}
- key     : String               [`<case>:<name>`]
- version : int                  [pinned to one immutable version, whatever its status later (Q5d)]
```

### 3.2 Decision-tree nodes
```
Node «sealed»                    permits ConditionNode, ValueNode

ConditionNode «record»
- description : String
- lhs, rhs    : Operand          [v1: Constant | AttributeRef only (Q17)]
- operator    : String
- success, failure : Node        [both required]

ValueNode «sealed»               permits SingleValue, ListValue, MapValue   (shape chosen by the tree's return type)
SingleValue «record»  - value   : Operand
ListValue   «record»  - items   : List<Operand>
MapValue    «record»  - entries : List<MapEntry(Operand key, Operand value)>

DecisionTreeDefinition «record»  — the `data` JSON of one version
- caseName, name, description : String
- returns : ReturnSpec           [Q20: chosen in the UI; TypeRef + optional scale/rounding (big_decimal only)]
- root : Node

ReturnSpec «record»              - type : TypeRef  - scale : Integer  - rounding : RoundingMode

ExpressionDefinition «record»    — the `data` JSON of one expression version
- caseName, name, description : String
- body : Operand                 [usually an Expression; Constant/AttributeRef also allowed]
```

### 3.3 Misc
```
Status «enum»                    DRAFT | ACTIVE | INACTIVE
Kind «enum»                      DECISION_TREE | EXPRESSION      [selects repository, validator and hooks in VersionLifecycle]
Actor «record»  - id : String    [passed into every mutating call → created_by/updated_by]
```

---

## 4. Case & attribute configuration (`config`, `attribute`)

### 4.0 Where config comes from: the host service [Q1a]

```
RulerConfigSource «spi»          — produces the raw `ruler` config tree
+ load() : Map<String, Object>   [Ruler.Builder.build() → called once at startup]

RulerConfigSources               — built-in factories (non-Spring hosts)
+ map(Map)                       [A: host loads its config itself]
+ yaml(Path | classpathResource, prefix)      [B: reads only the `ruler:` subtree of the host's file]
+ properties(Path | Properties, prefix)       [B: `ruler.decision-trees[0].case=…` → unflattened into Map/List]
+ composite(sources…)            [merges by case name; a duplicate case = ConfigurationException]
```
Spring hosts: `RulerAutoConfiguration` binds `ruler.*` from the host's `Environment` with Spring's `Binder` → `RulerConfigSources.map(...)`. Profiles, env overrides and placeholders come free.

```yaml
# host application.yml
ruler:
  math: { division-scale: 10, rounding: HALF_EVEN }
  web:  { enabled: true, base-path: /ruler }
  decision-trees:
    - case: stamp-duty
      attributes:
        - { name: loan amount, path: loan_details.amount, container_type: primitive, data_type: big_decimal }
        - name: slab rate
          isDynamic: true
          container_type: primitive
          data_type: big_decimal
          params:
            - { name: state, container_type: primitive, data_type: string, allowed_values: [MH, KA] }
```

### 4.1 Case model
```
CaseDefinition «record»
- name       : String
- attributes : Map<String, AttributeDefinition>     [keyed by code]
- byPath     : Map<String, AttributeDefinition>     [static attributes keyed by path → AttributeRef lookup (Q5)]

AttributeDefinition «record»
- name, code, description : String     [code = name.replace(' ', '_'), derived if absent]
- dynamic : boolean
- path    : String               [static only; at most one '*' (Q13)]
- type    : TypeRef
- params  : List<ParamDefinition>   [dynamic only]

CaseConfigLoader
+ load(Map tree, DataTypeRegistry, AttributeFactory) : CaseRegistry
      [Ruler.Builder at startup → bind, then fail fast on: duplicate code/path, static without path,
       more than one '*', dynamic without a registered executor, params on a static attribute,
       unknown data_type, min > max]
CaseRegistry                     — immutable after startup
+ get(caseName) : CaseDefinition [services, validators, evaluator; throws NotFound]
```

### 4.2 Dynamic-attribute params and UI APIs [Q6]
```
ParamDefinition «record»         — declared per dynamic attribute in config; served to the UI
- name, description : String
- type      : TypeRef
- required  : boolean            [default true]
- defaultValue : Object          [the UI pre-fills it; used when an optional param is omitted]
- min, max  : Number             [numeric → value range; string → length; list/map → size]
- allowedValues : List<Object>   [the UI renders a dropdown]
- pattern   : String             [string regex]
+ check(value, path, result)     [ParamBindingValidator on save (CONSTANT); OperandEvaluator at eval (ATTRIBUTE-sourced)]

ParamBindingValidator            — called by OperandTypeChecker for each dynamic AttributeRef
                                   every required param is bound, there are no unknown names, binding types
                                   are assignable, and CONSTANT values pass check(); ATTRIBUTE bindings must be static paths

CatalogService                   — read-only metadata for the UI builder
+ getAttributes(case) : {case, attributes:[{name, code, path, description, dynamic, container_type, data_type, params}]}
+ getAttributeParams(case, code) : List<ParamDefinition>
      [UI → the user selects a dynamic attribute → render inputs with constraints]
+ getExpressions(case, resultType?) : [{key, name, version, description, container_type, data_type}]
      [UI EXPRESSION_REFERENCE picker → ACTIVE version per name; the optional filter shows only ones that fit the slot]
+ getTypes() : {containers, data_types}   [UI return-type and constant-type dropdowns; built-ins + host types]
+ getOperators(container, dataType) :
      { condition:  [{name, rhs:{container_type, data_type}}],
        arithmetic: [{name, rhs:{…} | null (unary), result:{container_type, data_type}}] }
      [one call for both kinds, read straight from OperatorRegistry]
```

### 4.3 Attribute resolution
```
DynamicAttribute «spi»           (spec §3.2)  + getName()  + execute(name, context, params)

AttributeFactory                 — registry of dynamic executors (spec §3.3)
- executors : Map<String, DynamicAttribute>  [filled by builder / Spring beans; frozen at build()]
+ register(DynamicAttribute) / register(name, BiFunction<Object, Map, Object>)

PathResolver
- compiled : ConcurrentMap<String, List<Segment>>   [path → parsed segments, parsed once]
+ resolve(context, path) : Object
      [OperandEvaluator, SampleInputValidator → walks Map / List / array / record component / public getter;
       numeric segment = index; '*' (one only) = apply the remaining path to each element → List;
       missing → MISSING sentinel, so "absent" and "null" stay distinguishable]

ValueCoercer
+ coerce(raw, TypeRef) : Object  [delegates to DataType.coercer per element; never parses String→number; lossy → error]
```

---

## 5. Operators (`operator`)

```
ConditionOperatorSpec «record»   name, lhs : TypeRef, rhs : TypeRef, test : BiPredicate<Object,Object>
ArithmeticOperatorSpec «record»  name, lhs, rhs (null = unary), result : TypeRef, apply : BinaryOperator<Object>

OperatorRegistry                 — single source of truth: validation, evaluation, UI API
- conditions : Map<Key(name, lhsType), ConditionOperatorSpec>
- arithmetic : Map<Key(name, lhsType), ArithmeticOperatorSpec>
- numeric    : NumericContext    [passed to big_decimal divide]
+ condition(name, lhsType) / arithmetic(name, lhsType, rhsType)
      [exact match first, then DataTypeRegistry.promote(l, r)]
+ listFor(TypeRef) : {condition, arithmetic}   [CatalogService.getOperators]
+ register(spec)                 [BuiltInOperators at build; host fills the "To define" rows]
```
Built-ins = spec §7/§8 tables, plus these proposed rows:

| container/data | condition ops | arithmetic ops |
|---|---|---|
| primitive/numeric (integer, long, double, big_decimal) | equals, GT, LT, GTE, LTE, in | add, subtract, multiply, divide (integer/long divide → double; big_decimal uses NumericContext) |
| list/numeric | contains, contains_any, contains_all | sum, min, max (unary → primitive), add_all, union, intersection |
| map/* | contains_key, contains_value | — (v2) |

---

## 6. Validation (`validation`) [Q7]

```
ValidationError «record»         path ("$.root.success.lhs"), code ("OPERATOR_TYPE_MISMATCH"), message
ValidationResult                 collects all errors (not fail-fast);  + throwIfInvalid() → ValidationException
ValidationContext «record»       caseDef, operators, expressionLookup ((key, version) → ExpressionDefinition)

OperandTypeChecker               — bottom-up type inference
- refMemo : Map<String, TypeRef> [per call; each referenced version is typed once]
+ typeOf(Operand, path, ctx, result) : Optional<TypeRef>
      Constant:      non-null and coercible to its declared type
      AttributeRef:  static → caseDef.byPath has the path; dynamic → code exists + ParamBindingValidator
      Expression:    typeOf(lhs), typeOf(rhs) FIRST (innermost → outermost) → registry.arithmetic(op, l, r).result
      ExpressionRef: the version exists and is ACTIVE at save time ⚠ → typeOf(body), depth limit 32
      empty = invalid; the parent skips its own check so errors don't cascade.
      Cycles are impossible: a version can only reference versions that already exist.

TreeValidator «spi»              + isActive()  + getPriority() (lower first)  + validate(def, ctx, result)

ConditionValidator               — one ConditionNode: the operator exists for typeOf(lhs); typeOf(rhs) container
                                   and data type are assignable to spec.rhs; operand kinds allowed (Q17); both branches present
ValueNodeValidator               — one leaf: shape matches the return container; every item/key/value is assignable
HierarchyValidator (10)          — DFS over every branch → ConditionValidator / ValueNodeValidator; max depth 64
ReturnTypeConsistencyValidator (20) — every leaf type widens to tree.returns
ExpressionValidator              — expressions: typeOf(body) must succeed → stored as resultType

ValidationEngine
- validators : List<TreeValidator>  [built-ins + host; filtered by isActive and sorted at build]
+ validate(def, ctx) : ValidationResult   [VersionLifecycle on create/update/reactivate]

SampleInputValidator             [Q5] — runs only on approve
+ validate(def, sampleInput, ctx) : ValidationResult
      collect every static path used (conditions, leaves, param bindings, inside expressions and,
      recursively, referenced expressions) → PathResolver.resolve(sample, path)
      MISSING → PATH_NOT_FOUND;  value does not fit declared TypeRef → PATH_TYPE_MISMATCH (expected vs actual)
      '*' over an empty list → SAMPLE_EMPTY_LIST (the element type cannot be verified)
      Dynamic attributes are skipped (never executed during approval).
```

---

## 7. Evaluation (`eval`) — direct interpreter, no cache [Q16]

```
Evaluator
+ evaluate(DecisionTreeDefinition, CaseDefinition, context) : Object
      [EvaluationService → iterative loop (no recursion): at a ConditionNode
       evaluate lhs/rhs → registry.condition(op, type).test → go to success or failure;
       at a ValueNode build Single / List / Map → apply tree.returns scale/rounding.
       Errors are wrapped with treeKey, version and node path]

OperandEvaluator
+ eval(Operand, EvalContext) : Object
      Constant → value;  static AttributeRef → PathResolver → ValueCoercer (MISSING → fail, Q8);
      dynamic → bind params (+ check ATTRIBUTE-sourced values) → AttributeFactory.execute → coerce;
      Expression → eval lhs, rhs → registry.arithmetic(...).apply;  ExpressionRef → ctx.loadRef → eval body

EvalContext                      — per evaluation, never shared
- root : Object                  [user input]
- attrMemo : Map<String,Object>  [code/path + params → value; dynamic executors run once per evaluation]
- refMemo  : Map<(key,version),ExpressionDefinition>   [each ref is loaded from the repo once per evaluation]

EvaluationResult «record»        value, treeKey, version   [version is returned for audit/debug]

// Extension point (not in v1): cache compiled ACTIVE trees + immutable expression versions, keyed by (key, version).
```

---

## 8. Persistence (`persistence`) — SPI with in-memory default

The two tables in the spec have the same shape, so one record type and one base contract serve both.

```
VersionedRecord «record»
- key        : String            ["<case>:<name>"]
- version    : int               [1, 2, 3 …; (key, version) unique → DDB PK + SK / RDBMS composite unique key (Q3)]
- status     : Status
- data       : String (JSON)     [full definition; replaced as a whole on update (Q14)]
- resultType : TypeRef           [expressions only; computed on save → UI filter]
- description, remarks, createdBy, createdAt, updatedBy, updatedAt

StatusTransition «record»        key, version, from, to, actor, at, remarks     [status history]

VersionedRepository «spi»
+ insertDraft(record)            [ATOMIC: insert only if no DRAFT exists for key and version = latest+1
                                  → SQL: partial unique index (key) WHERE status='DRAFT' → ConflictException]
+ approve(key, version, actor, remarks, at)
                                 [ATOMIC: CAS this version DRAFT→ACTIVE + current ACTIVE→INACTIVE (if any)
                                  + 2 transitions; all or nothing → ConflictException]
+ transition(key, version, expectedFrom, to, actor, remarks, at)   [CAS + transition row; reject, markInactive]
+ find(key, version) / findActive(key) / findDraft(key) / findLatest(key)
+ history(key) / transitions(key)

DecisionTreeRepository «spi» extends VersionedRepository       → DecisionTreeTable
ExpressionRepository «spi»   extends VersionedRepository       → ExpressionTable
+ listActive(case)               [CatalogService.getExpressions]

InMemoryDecisionTreeRepository, InMemoryExpressionRepository   — default + test double; a per-key lock gives the same atomicity
```

---

## 9. Lifecycle & services (`service`, `hook`)

```
   create (put)  ──────────▶ ┌───────┐   approve(sampleInput)   ┌────────┐
   update (patch) ─────────▶ │ DRAFT │ ───────────────────────▶ │ ACTIVE │
   reactivate(vN) ─────────▶ └───────┘  (prev ACTIVE → INACTIVE) └────────┘
     (new version, copy of vN)  │ reject                            │ markInactive
                                ▼                                   ▼
                            ┌──────────┐ ◀──────────────────────────┘
                            │ INACTIVE │ ── reactivate → new DRAFT (vN unchanged)
                            └──────────┘
  Invariants per key:  ≤1 DRAFT, ≤1 ACTIVE; versions are immutable except for status.
```

```
VersionLifecycle                 — the state machine above, shared by both kinds [Q4]
- repos     : Map<Kind, VersionedRepository>
- validate  : Map<Kind, (data, case) → ValidationResult>      [tree → ValidationEngine; expression → ExpressionValidator]
- hooks, sampleValidator, clock, codec
+ create(kind, data, actor)                       validate → insertDraft(v1; Conflict if key exists) → creation hook
+ update(kind, key, data, remarks, actor)         findDraft ≠ null → 409 → validate full data → insertDraft(latest+1) → patch hook
+ approve(kind, key, version, sampleInput, actor, remarks)
                                                  must be DRAFT → SampleInputValidator (fail → 400, stays DRAFT) → repo.approve
+ reject(kind, key, version, actor, remarks)      remarks required (blank → 400) → repo.transition(DRAFT → INACTIVE, remarks)
+ markInactive(kind, key, actor, remarks)         repo.transition(ACTIVE → INACTIVE) → inactive hook
+ reactivate(kind, key, version, actor, remarks)  must be INACTIVE → re-validate its data against today's config
                                                  → insertDraft(latest+1, copy) → patch hook

DecisionTreeService / ExpressionService          — thin public API over VersionLifecycle (spec names kept)
  put*, get*(case, name) [ACTIVE else NotFound], get*(case, name, version), patch* (full data), approve*, reject*,
  markInactive, reactivate*, history*
EvaluationService
+ evaluate(case, name, context) : EvaluationResult   repo.findActive (NotFound if none) → parse → Evaluator
```

```
PostCreationHook «spi»     + onCreated(LifecycleEvent)          [after create]
PostPatchHook «spi»        + onPatched(LifecycleEvent)          [after update / reactivate]
InactiveMarkingHook «spi»  + onInactivated(LifecycleEvent)      [after markInactive]
LifecycleEvent «record»    kind (DECISION_TREE | EXPRESSION), key, version, previousVersion, status, remarks, actor, at
                           [one class may implement several hooks; a hook filters on `kind` if it only cares about trees]

HookDispatcher                   [Q18]
+ fire(List<H>, event)           [VersionLifecycle AFTER the repo write succeeds → runs each hook in turn on the
                                  caller's thread, each in try/catch(Throwable) → System.Logger WARN;
                                  // TODO: move to an executor so slow hooks don't add latency]
```

---

## 10. Spring Boot starter (`ruler-spring-boot-starter`) [Q12]

```
RulerProperties  @ConfigurationProperties("ruler")   — math, web.enabled, web.base-path (+ the raw tree passed to core)
RulerAutoConfiguration           — builds the Ruler bean: binds `ruler.*` → RulerConfigSources.map; collects beans of
                                   DynamicAttribute, hooks, repositories, TreeValidator, DataType, operator specs;
                                   @ConditionalOnMissingBean → the host can override any of them
ActorResolver «spi bean»         — HttpServletRequest → Actor; default: header `X-Ruler-Actor`; host overrides (e.g. Spring Security)
RulerExceptionHandler @RestControllerAdvice
      Validation 400 {errors:[{path, code, message}]}, NotFound 404, Conflict/IllegalTransition 409,
      Evaluation 422, other 500
```
REST (base path `/ruler`, enabled by `ruler.web.enabled`). Expressions use the same routes under `/expressions`:

| Method | Path | Service |
|---|---|---|
| POST | `/decision-trees` | put (create v1 DRAFT) |
| GET | `/decision-trees/{case}/{name}[?version=]` | get (ACTIVE or the given version) |
| PUT | `/decision-trees/{case}/{name}` body `{data, remarks}` | patch (full replace → new DRAFT) |
| POST | `/decision-trees/{case}/{name}/versions/{v}/approve` body `{sampleInput, remarks}` | approve |
| POST | `/decision-trees/{case}/{name}/versions/{v}/reject` | reject |
| POST | `/decision-trees/{case}/{name}/inactivate` | markInactive |
| POST | `/decision-trees/{case}/{name}/versions/{v}/reactivate` | reactivate |
| GET | `/decision-trees/{case}/{name}/history` | history + transitions |
| POST | `/evaluate/{case}/{name}` body = context | evaluate |
| GET | `/catalog/{case}/attributes`, `/catalog/{case}/attributes/{code}/params` | CatalogService |
| GET | `/catalog/{case}/expressions[?container=&dataType=]`, `/catalog/operators?container=&dataType=` | CatalogService |

---

## 11. Bootstrap (`Ruler`, core) — manual wiring for non-Spring hosts

```
Ruler.builder()
  .config(RulerConfigSource…)  .dynamicAttribute(…)  .dataType(…)
  .decisionTreeRepository(r) .expressionRepository(r)          [default in-memory]
  .postCreationHook(h) .postPatchHook(h) .inactiveMarkingHook(h)
  .validator(TreeValidator) .conditionOperator(spec) .arithmeticOperator(spec)
  .codec(JsonCodec) .clock(Clock)
  .build()     [register types + operators → freeze registries → load + merge config → CaseConfigLoader → wire services]
Ruler: decisionTrees() expressions() evaluation() catalog()
```

---

## 12. Key flows

**Evaluate**
```
evaluate(case,name,ctx) ─▶ repo.findActive(key) ─(none)─▶ 404
                               └▶ parse data ─▶ Evaluator loop:
                                    Condition: OperandEvaluator(lhs, rhs) ─▶ op.test ─▶ success | failure
                                    Value:     build result ─▶ EvaluationResult(value, key, version)
```

**Update → Approve**
```
update:  findDraft? ─yes─▶ 409
                    └no──▶ validate(full data) ─ok─▶ insertDraft(latest+1) ─▶ PostPatchHook        (ACTIVE keeps serving)
approve: is DRAFT? ─▶ SampleInputValidator(sampleInput) ─errors─▶ 400 (stays DRAFT)
                                                       └ok──▶ repo.approve  ═ATOMIC═ { v: DRAFT→ACTIVE ; old: ACTIVE→INACTIVE }
```

---

## 13. Errors (`error`) — all unchecked
```
RulerException
├── ConfigurationException      startup: bad config, missing executor, duplicate code/path, >1 '*'
├── ValidationException         - errors : List<ValidationError>   (save-time and sample-input)
├── NotFoundException           case / key / version / no ACTIVE version
├── ConflictException           draft exists, key exists, CAS lost
├── IllegalTransitionException  e.g. approve on ACTIVE, reactivate on DRAFT
└── EvaluationException         - key, version, nodePath ; missing attribute, executor failure, divide by 0
```

## 14. Concurrency notes
- Registries are frozen at `build()`, so reads need no locks. Evaluation is stateless apart from a per-call `EvalContext`.
- Write races (two updates, approve vs reject) are resolved by repository CAS → `ConflictException`.
- Hooks run synchronously after the write has committed, so a hook failure cannot roll it back.

---

## 15. Implementation notes (as built)

Decisions taken while implementing. These are additive to §0; nothing above was changed.

| Topic | As built |
|---|---|
| `DataType` | Interface + `BuiltInDataType` enum, with per-constant `coerce` (strict, runtime values) and `parse` (lenient, authored values). Operators stay in `OperatorRegistry`. |
| Constant types | Text, booleans and whole numbers infer their type. A decimal constant must declare `data_type` (`CONSTANT_TYPE_REQUIRED`), because `0.2` is ambiguous between `double` and `big_decimal`. Authored constants may be strings, e.g. `"0.001"`. |
| Config keys | snake_case is canonical; `isDynamic` / `is-dynamic` are also accepted (`TreeAccess`). |
| Remarks | Required on update, reactivate and reject (spec §10.2 "every update must capture remarks"); optional on create, approve and markInactive. |
| Approve re-validation | Approve re-validates the stored draft against today's config, with `requireActiveReferences = false`: a draft saved against `duty@1` can still be approved after `duty@2` replaced it (pinned refs, Q5d). New versions (create/update/reactivate) must reference ACTIVE versions. |
| Hooks | `PostCreationHook`, `PostPatchHook`, `InactiveMarkingHook` + `LifecycleEvent.kind`; synchronous, isolated in try/catch (Q18 TODO in `HookDispatcher`). |
| REST bodies | create/update: `{data: <definition>, remarks}`; approve: `{sample_input, remarks}`; reject/inactivate/reactivate: `{remarks}`; evaluate: the input itself. Responses are snake_case via Ruler's own codec, so the host's ObjectMapper is untouched. Actor comes from header `X-Ruler-Actor` (override the `ActorResolver` bean). |
| Spring config | `SpringEnvironmentConfigSource` reads every `ruler.*` property through the Environment, so profiles, overrides and `${...}` placeholders apply. |
| Paths on POJOs | Record components, `getX()/isX()`, `x()` and public fields; snake_case segments also match camelCase members. `Object` methods (`getClass`) are never reachable. |

### 15.1 Refactor v2: standard libraries instead of hand-written plumbing (approved 2026-11-07)

| Concern | Now uses |
|---|---|
| Config | Typed JavaBeans `RulerConfig` → `CaseConfig` → `AttributeConfig` → `ParamConfig`. Core: Jackson YAML / `JavaPropsMapper` + key normalization (config keys only, never inside values). Spring: `RulerProperties extends RulerConfig`, `@ConfigurationProperties("ruler", ignoreUnknownFields = false)` + generated IDE metadata. |
| Config shape | Jakarta Bean Validation (Hibernate Validator, `ParameterMessageInterpolator`, no EL). Meaning checks stay in `CaseConfigLoader`. |
| Definition JSON | Jackson `@JsonTypeInfo` on `Operand` / `Node`; `@JsonCreator` factories on the model records check shape and throw `ShapeException(code, field)`. `DefinitionParser` maps Jackson's path to `$.a.b[i]`. Shape errors stop at the first; meaning errors are still collected. |
| Return type (Q20) | `DecisionTreeDefinition.returns : ReturnSpec(type, scale, rounding)`. Locked after v1 (`RETURN_TYPE_LOCKED`, checked before full validation). `CatalogService.getTypes()` / `GET /catalog/types`. |
| Boilerplate | Lombok `@lombok.Builder(builderClassName = "Builder")` + `@Singular` on `Ruler.create(...)`, `@RequiredArgsConstructor`, `@Getter/@Setter` on config beans, `@Slf4j`. Nothing from `lombok.experimental`. |
| Hooks (Spring) | `RulerEvents.Publisher` publishes `LifecycleEvent` (now with `action`). `RulerEvents.HookRunner` (`@TransactionalEventListener(fallbackExecution = true)`) runs host hook beans on Boot's `applicationTaskExecutor`. Hosts may also use `@EventListener`. |
| REST | Request/response records serialized by Spring, snake_case via `@JsonNaming` (host ObjectMapper untouched). Errors are RFC 9457 `ProblemDetail` with `code` and `errors`, from a `ResponseEntityExceptionHandler` scoped to Ruler's controllers. `evaluate` reads its body as text so decimals stay exact. |
| API docs | springdoc-openapi picks the controllers up when the host adds it (verified in tests). |
| Tests | AssertJ, Awaitility, `ApplicationContextRunner`. |

---

## 16. UI support APIs (added 2026-11-07)

Read and dry-run APIs for a decision-tree builder UI. All additive: existing endpoints and methods behave as before.
Every REST endpoint delegates to a public core method.

| API | Core (Spring-free) | REST |
|---|---|---|
| A. List cases | `CatalogService.getCases()` → `CaseView(name, attributeCount)`, sorted by name | `GET {base}/catalog/cases` |
| B. List rules | `DecisionTreeService.list(case)`, `ExpressionService.list(case)` → `VersionSummary`, built in `VersionLifecycle.list` from `findLatest / findActive / findDraft`; unknown case → `NotFoundException` | `GET {base}/decision-trees?case=`, `GET {base}/expressions?case=` |
| C. Attribute filter | `CatalogService.getAttributes(case, TypeRef slotOrNull)`; the old method delegates with null; uses `isAssignableTo` (integer fits double) | `GET {base}/catalog/{case}/attributes?container_type=&data_type=&key_type=` |
| D1. Whole-tree dry run | `DecisionTreeService.validate(json)`, `ExpressionService.validate(json)` → `ValidationResult`: the create checks (shape, case, validators, ACTIVE references), nothing stored, no hooks; `ValidationException` → result | `POST {base}/decision-trees/validate`, `POST {base}/expressions/validate` |
| D2. One card | `DecisionTreeService.validateNode(case, nodeJson, returnsJson, path)` → `NodeValidationResult(valid, resultType, errors)` via `NodeValidator` | `POST {base}/decision-trees/validate-node` |

```
VersionedRepository «spi»
+ keys(caseName) : List<String>     [new, required: distinct keys of the case, sorted; in-memory matches on the
                                     stored case name, not a key prefix]

VersionSummary «record»             key, caseName, name, description, latestVersion, latestStatus,
                                    activeVersion?, draftVersion?, updatedBy, updatedAt (latest), returnType (TypeView)

NodeValidator                       — one card of a tree being built; dispatches on node.type
+ validate(nodeJson, returnsJson, basePath, ctx) : Outcome(result, type)
      condition  → ConditionValidator.validateOperands (lhs / operator / rhs; branches ignored)
      value      → ValueNodeValidator + ReturnTypeConsistencyValidator.checkLeaf against `returns`
      operand    → OperandTypeChecker.typeOf (result type returned)
      errors are prefixed with basePath (default $), so they equal save-time paths
```

- Small refactor, no behaviour change: `ConditionValidator.validateOperands` and `ReturnTypeConsistencyValidator.checkLeaf`
  are extracted; the existing `validate` methods call them in the same order as before (the 63 earlier tests pass unchanged).
- New parser entry points: `DefinitionParser.parseOperand`, `parseValueNode`, `parseReturns`.
- REST status: definition problems → always 200 `{valid, errors}`; a broken request (invalid JSON, missing `data`,
  `case` or `node`) → 400 ProblemDetail. `/validate` and `/validate-node` are one path segment, so they cannot
  match the two-segment `/{caseName}/{name}` routes.
- The dry run checks what create checks; "draft already exists" and "return type locked" are still reported by the update itself.

---

## 17. Sample data on every version (added 2026-11-07)

Every tree and expression version carries a `sample_data`: a real-looking input given by its author.

| Where | Rule |
|---|---|
| Create / update | `sample_data` **required** (`REQUIRED` at `$.sample_data`). Checked by `SampleInputValidator` against every static attribute path the definition uses (including inside referenced expressions); a mismatch fails the save with `PATH_NOT_FOUND` / `PATH_TYPE_MISMATCH` at the node path. |
| Storage | `VersionedRecord.sampleData` (JSON), in both tables. |
| Reads | `get`, `history` and create/update responses return `sample_data` as a JSON object, for the app to show. |
| Approve | `sample_input` is optional and defaults to the stored `sample_data`; an explicit one is still checked (callers that send it keep working). |
| Reactivate | Copies the source version's `sample_data` and re-checks it under today's config. |
| Dry run (`/validate`) | Requires and checks `sample_data` like create, so validate and save agree. |
| Card check (`/validate-node`) | Unchanged: a half-built card has nothing to check a sample against. |

Core signatures: `putDecisionTree(json, sampleData, remarks, actor)`, `patchDecisionTree(case, name, json, sampleData, remarks, actor)`,
`validate(json, sampleData)`; the same on `ExpressionService`. Breaking change, accepted because nothing is released.
Request-validation errors now report snake_case field paths (`$.sample_data`) in a fixed order.

### Evaluation order (confirmed, unchanged)

For a condition and for an expression alike: ① resolve lhs (a dynamic attribute's executor runs here), ② resolve rhs
(same; skipped for unary operators), ③ only then apply the operator (compare / calculate). A nested expression operand
is fully calculated in ① or ②. Dynamic attributes are memoized per evaluation (one call per attribute + params).

---

## 18. Enum data type (added 2026-11-07)

`data_type: enum` + `allowed_values`: a string limited to predefined values. Allowed on attributes, dynamic-attribute
params, attribute operands and a tree's `returns`; with `container_type` primitive, list or map (as the value type).

```
EnumDataType «DataType»          — typeName "enum", javaType String, values (order kept for display)
+ coerce(raw)                    [strict: a String that is one of the values, else IllegalArgumentException]
equality                         [same set of values]
widening (DataTypes.widensTo)    [enum → string; enum → enum that has all of its values (subset)]
stored type text                 [primitive/enum[MH,KA], map[string,enum[MH,KA]]; values limited to [A-Za-z0-9_-]]

EnumConstants (validation)       — constants are plain strings; where an enum is expected they are checked as members
+ adopt(operand, actual, expected, path, result)
      [value nodes (single / list items / map values) vs an enum returns; constants bound to enum params]
+ checkComparison(...)           [conditions with equals / not_equals / in / contains / contains_any / contains_all:
                                  the constant side must hold members of the enum side → ENUM_VALUE_NOT_ALLOWED;
                                  text operators such as prefix_match are not restricted]
```

| Where | Behaviour |
|---|---|
| Operators | every string operator works on an enum (via widening); string operations return `string` |
| Runtime input / dynamic result | a value outside the list → `EvaluationException` (422) naming the attribute |
| sample_data | a value outside the list → `PATH_TYPE_MISMATCH` at save |
| Expression result type | stays enum when the expression passes an enum through (e.g. a bare attribute) |
| Tree returns | member constants and enums with a subset of the values are accepted; the result is checked at runtime; the value list is part of the return type, so changing it is `RETURN_TYPE_LOCKED` |
| Catalog | `TypeView.enum_values` (null for other types); `/catalog/types` lists `enum` |
| Config checks | non-empty, unique, well-formed `allowed_values`; `allowed_values` on a non-enum attribute is an error (params keep `allowed_values` as a whitelist for other types) |

Dynamic attributes without params were already supported (the executor receives an empty map); covered by test EN8.

---

## 19. Value nodes hold expressions (added 2026-11-07)

A value node's slots always hold an **expression**: by name (`EXPRESSION_REFERENCE`) or in full. A full expression is
`EXPRESSION` (operator + operands, nested freely) or one of the simplest expressions, `CONSTANT` and `ATTRIBUTE`.

```json
{ "type": "value", "value":   <expression> }
{ "type": "value", "items":   [ <expression>, ... ] }
{ "type": "value", "entries": { "stamp_duty": <expression>, "total": <expression> } }
```

| Rule | Detail |
|---|---|
| Map results | `map[string, expression]`: `entries` is a JSON object; keys are fixed, non-blank strings; order is kept in the result |
| Return type | a map return type needs `key_type: string` (`INVALID_TYPE` at `$.returns.key_type` otherwise) |
| Old format | `entries: [{key, value}]` is no longer accepted (`INVALID_SHAPE` at `$.root.entries`) |
| Duplicate keys | rejected while the JSON is read (strict duplicate detection, applies to every definition object) |
| Error paths | map values report at `$.<node>.entries.<key>`, e.g. `ENTRY_VALUE_TYPE_MISMATCH` at `$.root.entries.total` |

`ValueNode.MapValue(Map<String, Operand>)` replaces the old `List<Entry>`; validation, the sample check, evaluation and
`validate-node` walk the map values. Breaking change, accepted because nothing is released.

### 18.1 Enum slots in catalog filters (added 2026-11-07)

`GET /catalog/operators`, `GET /catalog/{case}/attributes` and `GET /catalog/{case}/expressions` take an optional
`allowed_values` query param (comma-separated, e.g. `data_type=enum&allowed_values=MH,KA`; repeated params also work).
It is parsed into the same `TypeRef` as `returns.allowed_values`, and filtering keeps the existing rules
(enum → string; enum → enum with all of its values). `data_type=enum` without it stays a 400; `allowed_values` with a
non-enum `data_type` is a 400; without the param nothing changes. REST-only: the core already filtered by any `TypeRef`.

---

## 20. Expressions declare their return type (added 2026-11-07)

Expressions follow decision trees: the definition carries a required `returns` block, chosen when it is created.

```json
{ "case": "stamp-duty", "name": "stamp_duty",
  "returns": { "container_type": "primitive", "data_type": "big_decimal", "scale": 2, "rounding": "HALF_UP" },
  "expression": { ... } }
```

| Where | Rule (same as trees) |
|---|---|
| Create / update | `returns` required (`REQUIRED` at `$.returns`); `scale`/`rounding` big_decimal only; enum needs `allowed_values` |
| Validation | the body's computed type must fit `returns` (widening allowed, e.g. integer → double; string constants adopt an enum when they are members); otherwise `RETURN_TYPE_MISMATCH` at `$.expression` |
| Stored / shown | `result_type`, the list `return_type`, the catalog expression filter and `GET` data all use the declared type |
| References | an `EXPRESSION_REFERENCE` has the referenced expression's declared type, so trees validate against it |
| Evaluation | a referenced expression's result is converted to its declared type and then rounded with its `scale`/`rounding` (shared `Results.finish` with tree leaves) |
| Lock | changing the type after v1 → `RETURN_TYPE_LOCKED`; a different `scale`/`rounding` with the same type is allowed |

Inline expressions inside trees have no `returns` of their own: the tree's `returns` applies to the leaf.
Breaking change for expression create/update (accepted: nothing released).

---

## 21. List quantifiers, `$.` paths and case stamp-duty-v2 (added 2026-11-07)

**New condition operators** (core, every case, listed by `/catalog/operators`):

| lhs | Operators (rhs is one value of the element type) | Empty list |
|---|---|---|
| list of integer / long / double / big_decimal | `all_greater_than`, `all_greater_than_or_equal`, `all_less_than`, `all_less_than_or_equal`, `any_greater_than`, `any_greater_than_or_equal`, `any_less_than`, `any_less_than_or_equal` | `all_*` and `any_*` → false |
| list of any element type | `all_equals`, `none_equals` (any-equals is `contains`) | `all_equals` → false, `none_equals` → true |

A boolean "every party is an adult" is `$.parties.*.is_greater_than_18 all_equals true`.

**Paths** may start with `$.`, in config and in operands: `$.parties.*.party_id` and `parties.*.party_id` are the same
attribute (`PathResolver.normalize`). Static attributes are referenced by path, dynamic ones by code (Q5, unchanged).

**Example case `stamp-duty-v2`** (next to `stamp-duty`): a loan agreement between several parties, each with
property details. Static attributes cover the root fields and `parties.*.<field>`; `PARTIES_CITY_LIST` and
`PARTIES_AGE_LIST` are dynamic because `parties[].property_details[]` needs two `*`. Each dynamic attribute decides
its empty answer: no properties → cities `[]`, ages `[0]`. Seed tree `loan-duty`: minors → 0; MSME or SSI → 0.1%;
a property in Delhi → 0.5%; every property older than 18 years → 0.2%; otherwise 0.3%. A seed rule may carry its own
`sample_data` when its case has a different input shape.

---

## 22. Run trees and expressions, any version, with an explanation (added 2026-11-07)

| API | Core | Notes |
|---|---|---|
| `POST {base}/evaluate/{case}/{name}?version=&explain=` | `EvaluationService.evaluate(case, name, version, input, explain)` | no params → exactly as before (ACTIVE) |
| `POST {base}/expressions/{case}/{name}/evaluate?version=&explain=` | `EvaluationService.evaluateExpression(...)` | value in the declared `returns` type, scale applied |

- **Input**: the request body is the context, for trees and expressions alike.
- **version**: omitted → the ACTIVE version (404 when none); a number → that version whatever its status (DRAFT,
  ACTIVE, INACTIVE), e.g. to try a draft before approving it; unknown → 404.
- **Response**: `{value, key, version, result_type[, explanation]}`; `explanation` only with `explain=true`.

```
Explanation «record»   steps : List<Step>, attributes : List<AttributeValue>
Step                    kind CONDITION | CALCULATION | REFERENCE | VALUE, path, description, operation, lhs, rhs, result
                        [CONDITION: lhs/rhs values, operator, result = passed; CALCULATION: operands and result;
                         REFERENCE: description = "case:name@version", result = its value after its returns/scale;
                         VALUE: the value node reached / the expression's final value]
AttributeValue          code, path (static) or params (dynamic), value as used (first resolution only, memoized)
Trace (eval, internal)  collects both; created only when explain=true, so normal evaluation does no extra work
```
Errors are unchanged with `explain=true` (422 naming the failing node). A reference used several times is evaluated
each time it is used (the definition is loaded once), so it appears once per use in the steps.

---

## 23. Expressions in condition nodes (added 2026-11-07)

A condition's `lhs` and `rhs` may now be any operand: `CONSTANT`, `ATTRIBUTE`, an inline `EXPRESSION`, or an
`EXPRESSION_REFERENCE` (the v1 restriction Q17 is lifted: `ValidationContext.allowExpressionOperandsInConditions = true`).

```json
{ "type": "condition",
  "lhs": { "type": "EXPRESSION", "operation": "sum", "lhs": { "type": "ATTRIBUTE", "value": "$.parties.*.security_amount" } },
  "operator": "GTE",
  "rhs": { "type": "ATTRIBUTE", "value": "$.loan_amount" },
  "success_condition": { ... }, "failure_condition": { ... } }
```

- **Validation**: each side is typed bottom-up first (errors at the inner node, e.g. `$.root.lhs.rhs`); the operator
  is then checked against the two result types (a referenced expression has its declared `returns` type).
- **Evaluation**: both sides are calculated from the input, then compared (unchanged order: lhs, rhs, operator).
- **Explain**: the calculations and references appear just before the CONDITION step that uses their results.
- **Example** (`stamp-duty-v2`): expression `security_cover` = sum(security amounts) ÷ loan amount; tree
  `secured-loan-duty`: `security_cover GTE 1.0` → 0.1%; else `loan × 0.005 GT 10000` → 10000 (cap), else loan × 0.5%.
- **Example smoke test** (`ruler-example`): boots the service and runs the Swagger examples from `/v3/api-docs`
  against their expected results, so a broken seed or examples file fails `./gradlew build`.

---

## 24. stamp-duty-v2 rule catalog (example content, added 2026-11-07)

Example only; no library change. All rules live in `ruler-example/src/main/resources/seed/stamp-duty-rules.yml` and
are created and approved by `RuleSeeder` at startup (dependency order: an expression can only reference ACTIVE versions).

- **Expressions**: `total_security`, `unsecured_amount` (= max(loan − total_security, 0)), `unsecured_ratio`,
  `base_value` (= 30% × ((20% × (loan + 1 Cr)) + 2 Cr)), `duty_at_half_percent`, `oldest_property_age` /
  `newest_property_age` (max / min of the dynamic `PARTIES_AGE_LIST`), `distinct_states` (union of a list with itself),
  plus `security_cover` (§23). Exercise refs to refs, unary list operations and dynamic attributes inside expressions.
- **Trees**: `loan-agreement-duty` (map result; adult check, request-type `in`, MSME/SSI concession with `min()`,
  `unsecured_amount GT 0`, cap `duty_at_half_percent GTE 35000 → 35000 else duty_at_half_percent`),
  `property-risk-band` (enum LOW/MEDIUM/HIGH; conditions on stored and inline expressions), `duty-cap`
  (`base × 0.005 GTE 35000` inline), `distinct-states` (list result).
- The cap is 35,000 rather than 25,000 because base_value ≥ 6.6 M for any loan, so 0.5% of it is always ≥ 33,000:
  a lower cap would make the "else" branch unreachable.
- `ExampleApplicationTest` runs every v2 Swagger input through the big trees and checks 23 hand-worked results.

### 24.1 Example conventions for the UI (added 2026-11-07)

Applied to the seed rules and Swagger examples; **not enforced** by the library (other shapes stay valid).
- **Expression shape**: `lhs` is an ATTRIBUTE or CONSTANT, `rhs` is the nested expression, for add / multiply / min /
  max (results unchanged; e.g. base_value = 0.30 × (2 Cr + 0.20 × (loan + 1 Cr))). Division keeps its natural order
  (`unsecured_ratio`, `security_cover`), since `a ÷ b` with a calculated `a` cannot take this shape.
- **Conditions reference stored expressions** (no inline expressions), so a UI can make each one a link:
  `EXPRESSION_REFERENCE {value: "<case>:<name>", version}` → `GET {base}/expressions/{case}/{name}?version={version}`.
  New stored expression `loan_half_percent` replaces the inline 0.5% calculation in `secured-loan-duty`.
