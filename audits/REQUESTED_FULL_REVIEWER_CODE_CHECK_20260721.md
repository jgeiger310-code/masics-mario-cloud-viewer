# Requested full reviewer code check — 2026-07-21

Purpose: trigger the current GitHub Actions safety workflows against the current Mario viewer/reviewer codebase.

Scope requested by Jake:
- code syntax checks
- viewer regression logic checks already present in the repository
- ESLint static bug-risk checks
- npm dependency vulnerability audit
- Semgrep Community Edition static scan
- CodeQL JavaScript security analysis
- advisory Prettier formatting check

Not included in this trigger:
- live Dropbox progress JSON mutation
- live viewer behavior changes
- Playwright/browser smoke tests
- Lighthouse/browser performance smoke tests

This file is intentionally documentation-only and does not affect the live viewer.
