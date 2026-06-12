---
repo: "E:/GitHub/my-existing-app"        # target repository; naming it here grants write access
mode: "refactor"                          # "refactor" for an existing repo, "new" for a new one
branch: "orchestrator/refactor-auth"      # optional; created if it does not exist
push: true                                # optional per-task override of the default push setting
---

# Task: Refactor the authentication module

Work autonomously and complete the following without asking for confirmation:

1. Read the current authentication code under `src/auth/` to understand how tokens are
   validated and where the logic is duplicated.
2. Extract token validation into a single, well-named, testable helper function with a
   docstring and a detailed example.
3. Add or update unit tests for the new helper and run the full test suite. Only proceed
   once the tests pass.
4. Update the project documentation to describe the new helper.
5. Commit the change with a descriptive message and push to the remote.
6. Record what you did, with timestamps and the commit history, in this repository's
   `REPORT_YYYYMMDD.md` file.

Constraints:
- Only modify files inside this repository.
- Do not abbreviate variable, function, or file names; use full descriptive names.
