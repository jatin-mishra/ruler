# Ruler Library: Design and Implementation Requirements

## 1. Your Role

You are a Senior Principal Engineer with 20+ years of experience in software development, system architecture, cloud computing, and scalable application design.

Help me design and build **Ruler**, a pure vanilla Java library.

The designs and flows described below are rough and intended to communicate the requirements.

As a Principal Engineer, feel free to ask questions, challenge decisions, and improve the design. However, follow sound engineering principles and avoid unnecessary complexity.

## 2. Library Overview

Ruler is a pure vanilla Java library.

Users should be able to:

1. Define use cases and their attributes using YAML.
2. Register custom executors for dynamic attributes.
3. Define decision trees containing conditions and value nodes.
4. Define reusable, versioned expressions, including references to stored expressions.
5. Evaluate a decision tree by passing a context object containing the required attributes.
6. Receive the result according to the decision tree's configured return type.
7. Manage decision tree versions, approvals, and lifecycle states.
8. Access library functionality through public service methods or API controllers.

## 3. Use Case and Attribute Configuration

Each use case, referred to as a `case`, represents the evaluation of a particular object using a defined set of attributes.

Attributes are defined at the case level.

Example YAML:

```yaml
decision-trees:
  - case: "stamp-duty"
    returns:
      container_type: primitive
      data_type: double

    attributes:
      - name: "<attribute-name>"
        description: ""
        isDynamic: true
        path: ""
        code: ""
        container_type: ""
        data_type: ""
        params:
          - name: ""
            description: ""
            container_type: ""
            data_type: ""

      - name: "attribute2"
```

Attributes can be static or dynamic.

Each attribute has:

* `name`: Human-readable name, which may contain spaces.
* `code`: Unique identifier derived by replacing spaces in the name with underscores.
* `path`: Location of a static attribute in the evaluation context.
* `isDynamic`: Indicates whether the attribute is resolved by a custom executor.
* `container_type`: Attribute container type.
* `data_type`: Attribute data type.
* `params`: Parameters required for dynamic attributes.

### 3.1 Static Attribute Paths

Static attributes are resolved from the supplied context using their configured paths.

Supported examples:

```text
name.first
nameList.0.first
nameList.*.first
```

Path semantics:

1. `name.first`: Access the `first` field of `name`.
2. `nameList.0.first`: Access the `first` field of the first element in `nameList`.
3. `nameList.*.first`: Return a list containing the `first` field of every element in `nameList`.

### 3.2 Dynamic Attributes

Users can register custom executors for dynamic attributes.

```java
interface DynamicAttribute {
    String getName();

    Object execute(
        String name,
        Object context,
        Map<String, Object> params
    );
}
```

### 3.3 AttributeFactory

The factory maintains a registry of attribute executors.

```text
AttributeFactory

map<String, Function<Input, Output>>

registerAttribute(name, function)

execute(name, context, params) -> Output
```

## 4. Decision Tree Structure

A decision tree contains two types of nodes:

1. `ConditionNode`
2. `ValueNode`

### 4.1 ConditionNode

Each condition node contains:

* Left operand (`lhs`)
* Operator
* Right operand (`rhs`)
* Success branch
* Failure branch

When the condition passes, evaluation follows the success branch. Otherwise, it follows the failure branch.

Both branches may lead to another `ConditionNode` or a `ValueNode`.

### 4.2 ValueNode

A `ValueNode` produces the final result.

Its structure depends on the return type defined at the decision tree level.

**Primitive return type**

Allow:

* Constant
* Attribute
* Expression
* Expression reference

**List return type**

Allow lists containing constants, attributes, expressions, or expression references.

Examples:

* `list[integer]`
* `list[string]`
* `list[double]`

**Map return type**

Allow keys and values to be defined using constants, attributes, expressions, or expression references.

Examples:

* `map[string, double]`
* `map[integer, string]`

The result must match the decision tree's declared return type.

## 5. Expression Structure

Expressions can contain:

1. Constants
2. Attributes
3. Nested expressions
4. References to stored expressions

An expression uses an operator with left and right operands where applicable.

### 5.1 Nested Expression

```json
{
  "type": "EXPRESSION",
  "value": "",
  "operation": "ADD",
  "lhs": {
    "type": "ATTRIBUTE",
    "value": "<attribute-name>"
  },
  "rhs": {
    "type": "EXPRESSION",
    "value": "",
    "operation": "MULTIPLY",
    "lhs": {
      "type": "CONSTANT",
      "value": "0.001"
    },
    "rhs": {
      "type": "ATTRIBUTE",
      "value": "<dynamic-attribute-name>",
      "params": [
        {
          "name": "price_list",
          "container_type": "list",
          "data_type": "double"
        }
      ]
    }
  }
}
```

### 5.2 Constant

```json
{
  "type": "CONSTANT",
  "value": 200,
  "operation": ""
}
```

### 5.3 Percentage of Loan Amount

```json
{
  "type": "EXPRESSION",
  "value": null,
  "operation": "MULTIPLY",
  "lhs": {
    "type": "CONSTANT",
    "value": 0.20
  },
  "rhs": {
    "type": "ATTRIBUTE",
    "value": "loan_details.amount"
  }
}
```

### 5.4 Expression Reference

Previously stored expressions can be reused through `EXPRESSION_REFERENCE`.

```json
{
  "type": "EXPRESSION_REFERENCE",
  "value": "<expression-version-id>"
}
```

The value contains the unique ID of a specific expression version.

Every new expression version receives a new ID.

Existing references continue pointing to their specified expression version.

## 6. Condition Structure

Conditions contain:

* `lhs`
* `operator`
* `rhs`
* Success condition
* Failure condition

Operands initially support constants and attributes. Expression operands will be added later.

Example:

```json
{
  "type": "condition",
  "description": "",
  "value": "",
  "failure_condition": {},
  "success_condition": {},
  "lhs": {
    "type": "CONSTANT",
    "container_type": "",
    "data_type": "",
    "value": ""
  },
  "operator": "",
  "rhs": {
    "type": "ATTRIBUTE",
    "container_type": "",
    "data_type": "",
    "value": ""
  }
}
```

For constants, `container_type` and `data_type` identify the constant's type.

## 7. Conditional Operators

Available operators depend on the `container_type` and `data_type` of the left operand.

| Container type | Data type | Operators |
|---|---|---|
| primitive | string | equals, equals_ignore_case, prefix_match, suffix_match, not_equals, contains, in |
| primitive | double | equals, GT, LT, GTE, LTE, in |
| primitive | integer | equals, GT, LT, GTE, LTE, in |
| list | string | contains, contains_any, contains_all |
| list | integer | To define |
| list | double | To define |
| map | string | To define |
| map | integer | To define |
| map | double | To define |
| map | object | To define |

Other combinations may be supported later.

## 8. Arithmetic Operators

Initially, support:

* Primitive values.
* Lists and maps containing primitive data types.
* No nested lists or maps.
* No object types for arithmetic operations.

### Operator Types

| Container type | Data type | Operators |
|---|---|---|
| primitive | string | append_prefix, append_suffix, remove_prefix_length, remove_suffix_length, lower_case, upper_case |
| primitive | double | add, multiply, subtract, divide, etc. |
| primitive | integer | To define |
| list | string | intersection, union, remove_all_if_exists, add_all |
| list | integer | To define |
| list | double | To define |

Proper validation is required for every supported operator and operand type.

## 9. Persistence

The database implementation may change.

Keep persistence behind interfaces so users can override the storage implementation.

### 9.1 ExpressionTable

Fields:

* id
* name
* description
* version
* status
* data (JSON)
* remarks
* created_by
* created_at
* updated_by
* updated_at

Every new expression version must receive a new unique ID.

Maintain expression version history.

### 9.2 DecisionTreeTable

Fields:

* id/name: `<case>:<name>`
* description
* status
* version
* data (JSON)
* remarks
* created_by
* created_at
* updated_by
* updated_at

Maintain complete history across versions, including:

* Changes and remarks
* Update timeline
* Identity of the updater
* Status transitions

## 10. Decision Tree Lifecycle

A decision tree has three possible states:

1. `DRAFT`
2. `ACTIVE`
3. `INACTIVE`

### 10.1 Creation

New decision trees are created in `DRAFT` status.

The library supports registering `PostDTCreationHook` implementations during application startup.

After successful decision tree creation, trigger all registered post-creation hooks.

Hooks must follow fire-and-forget behavior.

Hook failures must not fail or roll back an otherwise successful creation.

### 10.2 Updates and Versioning

Every decision tree update creates a new version.

The new version starts in `DRAFT` status.

Only one draft version of a given decision tree may exist at a time.

If a draft already exists, another draft cannot be created until the existing draft is rejected -> INACTIVE.

The existing active version remains active and continues serving evaluations until the new version is approved.

Every update must capture:

* Remarks
* Updater
* Update timestamp
* Version history

### 10.3 Approval

There is no `markActive` API.

Instead, expose an approval API and a public approval service method.

The client can implement any maker-checker approval process before calling either.

Approval must atomically:

1. Mark the previously active version as `INACTIVE`.
2. Mark the approved draft version as `ACTIVE`.

Both changes must succeed together.

Until approval succeeds, the previous active version continues serving evaluations.

### 10.4 Draft Rejection

Provide a mechanism to reject an existing draft.

After rejection, a new draft version can be created.

### 10.5 Inactivation

Provide a `markInactive` API and a corresponding public service method.

When a decision tree is marked inactive:

1. Change its status to `INACTIVE`.
2. Trigger all registered `InactiveMarkingHook` implementations.

Hooks must follow fire-and-forget behavior.

Hook failures must not fail or roll back successful inactivation.

### 10.6 Lifecycle Hooks

Support registering lifecycle hooks during application startup.

**PostDTCreationHook**

Triggered after successful decision tree creation.

**InactiveMarkingHook**

Triggered after a decision tree is successfully marked inactive.

All registered hooks of the relevant type should be triggered.

Hooks must not block successful completion of the underlying operation.

## 11. Validation

Implement proper validation for condition nodes, value nodes, expressions, and complete decision trees.

### 11.1 ConditionValidator

Validates condition definitions.

### 11.2 HierarchyValidator

Validates conditions across the entire tree, from top to bottom and bottom to top.

Validation must cover:

* Every branch
* Condition nodes
* Expression nodes inside value nodes

```java
boolean isActive();

int getPriority();
```

### 11.3 ReturnTypeConsistencyValidator

Collects the return types of all value nodes and validates:

1. Return types are consistent across value nodes.
2. Every return type matches the decision tree's declared return type.

```java
boolean isActive();

int getPriority();
```

### 11.4 ConditionNode Validation

Validate:

* Operator
* Left operand
* Right operand
* Success branch
* Failure branch

Ensure the operator and operand types are compatible.

### 11.5 ValueNode Validation

Validation depends on the decision tree's declared return type.

**Single value**

* Constant: Validate non-null values and type compatibility.
* Attribute: Validate non-null references, attribute existence, and type compatibility.
* Expression: Validate the expression node and obtain its resulting container and data types.
* Expression reference: Resolve and validate the referenced expression version.

**List**

Validate every item.

**Map**

Validate every key and value.

### 11.6 ExpressionNode Validation

Validate nested expressions from the innermost node to the outermost node.

Each node must determine and return:

* Container type
* Data type

The parent expression uses these types for further validation.

## 12. Library APIs and Public Services

All APIs belong to the Java library itself.

Every operation exposed through an API controller must also be accessible through a public service method.

Clients must be able to call service methods directly without using the API controllers.

API controllers delegate to the same public service methods.

Attribute setup, whether static or dynamic, is backend configuration work.

### 12.1 Expression APIs

**putExpressionAPI(expression)**

1. Receive expression JSON.
2. Validate the expression tree.
3. Store it in `ExpressionTable`.

**getExpressionAPI(case, name)**

Retrieve the expression from storage.

**patchExpression(case, name, expression)**

1. Retrieve the existing expression.
2. Merge the changes.
3. Validate the updated expression.
4. Create a new expression version with a new unique ID.
5. Preserve the previous version and its history.

### 12.2 Decision Tree APIs

**getDecisionTree(case, name)**

Retrieve the decision tree from storage.

**putDecisionTree(decisionTree)**

1. Receive the decision tree.
2. Validate it.
3. Create it in `DRAFT` status.
4. Trigger registered post-creation hooks.

**patchDecisionTree(case, name, changes, remarks)**

1. Retrieve the existing decision tree.
2. Reject creation if a draft already exists.
3. Apply the changes.
4. Validate the updated tree.
5. Create a new version in `DRAFT` status.
6. Record remarks, updater, timestamp, and version history.
7. Keep the currently active version unchanged.

**approveDecisionTree(case, name, version)**

1. Retrieve the specified draft version.
2. Atomically mark the previously active version as `INACTIVE` and the approved version as `ACTIVE`.
3. Record the status transition.

Expose both an API and a public service method.

**rejectDecisionTree(case, name, version)**

1. Retrieve the specified draft version.
2. Reject the draft.
3. Allow a new draft to be created.

**markInactive(case, name)**

1. Mark the active decision tree as `INACTIVE`.
2. Trigger registered inactivation hooks.

### 12.3 Evaluation API

**evaluate(case, tree_id, context)**

1. Retrieve the active decision tree.
2. Evaluate conditions using the supplied context.
3. Follow the appropriate branches.
4. Evaluate the final value node.
5. Return the result.

## 13. Evaluation Logic

Evaluation starts at the root condition node.

For each condition:

1. Resolve `lhs`.
2. Resolve `rhs`.
3. Identify the operator.
4. Evaluate the condition based on the container and data types.
5. Follow the success or failure branch.
6. Continue until a value node is reached.
7. Evaluate the value node and return its result.

Each supported combination of `container_type` and `data_type` should know how to evaluate the relevant operator and operands.

Consider a better approach if necessary, without introducing unnecessary complexity.

## 14. Creation Workflows

The library must support creating:

**Decision trees**

* Condition nodes
* Value nodes

**Expressions**

* Expression nodes
* Nested expressions
* Constants
* Attribute references
* Stored expression references

## 15. Engineering Expectations

Treat this as an initial design, not a finalized architecture.

Review the design as a Senior Principal Engineer.

You may ask questions, identify gaps, challenge assumptions, and suggest improvements.

Prioritize correctness, extensibility, maintainability, and simplicity.

Do not introduce abstractions, frameworks, or complexity without a clear need.