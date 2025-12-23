# Agent Instructions

Instructions for AI agents (Claude, Cursor, Copilot, etc.) working on this codebase.

## Required Reading

Before making changes, read these files:
- `CLAUDE.md` — project overview, conventions, structure
- `CONTRIBUTING.md` — git workflow, branch naming, commit format

## Git Workflow for Agents

### Starting Work

1. **Always start from `dev` branch:**
   ```bash
   git checkout dev
   git pull origin dev
   ```

2. **Create a feature branch:**
   ```bash
   git checkout -b <prefix>/<descriptive-name>
   ```

3. **Branch prefixes:**
   | Prefix | Use |
   |--------|-----|
   | `feature/` | New functionality |
   | `bugfix/` | Non-urgent bug fixes |
   | `hotfix/` | Urgent production fixes (branch from `main`) |
   | `chore/` | Maintenance, dependencies, refactoring |
   | `docs/` | Documentation changes |

### Committing Changes

Use **conventional commits**:

```bash
git commit -m "<type>: <description>"
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`

**Examples:**
```bash
git commit -m "feat: add weekly digest email"
git commit -m "fix: correct timezone calculation"
git commit -m "test: add coverage for snooze handler"
git commit -m "chore: update dependencies"
```

### Before Pushing

**Always run tests:**
```bash
npm test
```

Do not push or create PRs if tests fail.

### Creating Pull Requests

```bash
git push -u origin <branch-name>
gh pr create --base dev --title "<type>: <description>" --body "## Summary
- <bullet points>

## Test plan
- [ ] Tests pass
- [ ] Manual verification"
```

**PR titles** should match conventional commit format.

### After PR Merge

The branch will be deleted automatically. If working locally:
```bash
git checkout dev
git pull origin dev
git branch -d <branch-name>
```

## Hotfix Process

For urgent production fixes only:

```bash
# Branch from main, not dev
git checkout main
git pull origin main
git checkout -b hotfix/<name>

# ... make fix ...
npm test

# PR to main
gh pr create --base main

# After merge, sync to dev
git checkout dev
git merge main
git push origin dev
```

## Code Quality Checklist

Before creating a PR, verify:

- [ ] `npm test` passes (all tests green)
- [ ] No TypeScript errors (`npm run lint`)
- [ ] Conventional commit messages used
- [ ] Branch name follows conventions
- [ ] PR targets correct base branch (`dev` or `main` for hotfix)

## What NOT to Do

- **Never push directly to `main` or `dev`** — always use PRs
- **Never force push** to shared branches
- **Never skip tests** before pushing
- **Never use `--no-verify`** to bypass hooks
- **Never commit secrets** or `.dev.vars`

## Agent-Specific Notes

### Context Awareness

- Check `git status` and `git branch` before starting work
- Read relevant files before modifying them
- Understand existing patterns before adding new code

### Incremental Changes

- Make small, focused commits
- One logical change per commit
- Test after each significant change

### Communication

- Summarize what was done after completing work
- Report test results
- Note any issues or decisions made
