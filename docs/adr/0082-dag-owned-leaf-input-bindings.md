# 0082. DAG-owned planned-edit leaf bindings

- Status: Accepted
- Date: 2026-07-28

## Context

A planned-edit task declared scheduling dependencies in `deps`, while pure execution
leaves independently read an `effect.args.from` reference. The Planner could therefore
produce a valid graph such as proposal → patch assembly but omit the duplicate `from`
field. Graph compilation succeeded, all expensive analysis and proposal steps ran, and
patch assembly then failed with “Leaf is missing its `from` upstream reference.” An
explicit `from` could also disagree with `deps`, making scheduling and data flow describe
different graphs.

## Decision

The validated task DAG is the authority for both scheduling and pure-leaf data flow.
During compilation, an analysis or patch leaf with dependencies receives a missing
`from` binding derived from those dependencies: one dependency becomes a scalar reference
and several become an ordered reference list. An explicit binding remains supported but
must name declared dependencies or compilation fails before execution.

Patch assembly accepts one or several bound upstream results and combines their typed
operations in dependency order before the existing validation and reversible assembly
path runs. Host and model tasks retain their own explicit argument contracts; verification
continues to consume the executor's run-level assembled edit.

## Consequences

Planner output no longer repeats graph edges in two fields, so the reported late montage
failure is eliminated and contradictory plans fail before analysis or mutation begins.
Multi-branch plans can deliberately fan operations into one validated patch. The compiler
now owns a small normalization step, and any new pure leaf whose input semantics differ
from dependency order must define that contract explicitly rather than adding an informal
second reference channel.
