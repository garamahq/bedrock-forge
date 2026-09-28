# Secret scan baseline

CI scans the complete Git history with Gitleaks. The root `.gitleaksignore` contains exact finding fingerprints for reviewed historical tutorial, seed, and test fixtures; it does not suppress files, rules, or future findings. Remove an entry when its historical fixture is removed or rewritten.

CI-only deterministic test values are annotated inline at their use site so they are not mistaken for production credentials. Keep real credentials out of source and rotate any value that was ever used outside tests or documentation.
