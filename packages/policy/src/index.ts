// The rule model: a Zod description for the UI and the API, a deterministic
// binary layout for PolicyConfig, and the evaluator with which the wizard shows
// the outcome before signing (FR-004).
//
// This evaluator is the second implementation of the same model that the Rust
// hook executes. A divergence between them is caught by differential tests on
// shared fixtures (SC-008); without them the duplicate drifts apart silently —
// docs/PLAN.md → Complexity Tracking #3.
export * from './evaluate.ts'
export * from './layout.ts'
export * from './model.ts'
export * from './scenarios.ts'
