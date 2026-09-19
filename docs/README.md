# SpacKt engineering documents

This set defines the product contract and records implementation evidence.
Implementation is active. Each completed phase has a report under `testing/`.

| Read | Purpose |
|---|---|
| [Product requirements](prd.md) | Outcomes, scope, journeys, acceptance, and submission requirements |
| [Architecture and decisions](architecture.md) | Chosen mechanisms, alternatives, SOLID boundaries, and reasons |
| [Wire schemas](schemas.md) | Exact JSON objects, metadata, bounds, and strictness |
| [Protocol contract](protocol.md) | Exact fields, units, timing, recovery, and resource bounds |
| [UI and UX design](design.md) | Layout, tokens, components, states, interaction, and accessibility |
| [Independent test plan](test-plan.md) | RED author ownership and concrete verification cases |
| [Implementation plan](implementation-plan.md) | Ordered tasks, files, commands, reviews, and commit gates |
| [Acceptance map](acceptance-map.md) | Requirement-to-task-to-test traceability |
| [Domain vocabulary](CONTEXT.md) | Consistent product terms |

## Workflow

Independent contract-derived RED tests precede behaviour implementation.
Review meaningful failures, implement GREEN, then refactor and rerun checks.
Keep expected RED commits on isolated task branches.
Integrate and deploy only reviewed GREEN task states.

Amar authorized implementation after the planning review.
Continue through reviewed GREEN checkpoints. External publication requires separate release authority.

## Planning verification

The independent full-set critic accepted this baseline after the identified contradictions were corrected.
The set contains 32 product requirements, 44 UI checks, and 117 planned test cases.
All 64 nonblank assignment lines were checked against the requirements.
Local document links and reference IDs passed validation.
The selected text/accent contrast examples exceed 4.5:1.
Those counts describe the planning baseline. They do not claim that every product test has run.
See [P01 evidence](testing/P01.md) for the completed contract and runner checks.
