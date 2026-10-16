## What & why

<!-- What does this change do, and why is it needed? -->

## How to test

<!-- Steps a reviewer can follow to verify this -->

## Checklist

- [ ] `make lint format-check typecheck test build` passes locally (the pre-commit/pre-push hooks cover all but `build`; see `make hooks-install`)
- [ ] No API keys, `.env` contents, personal data or third-party game assets in the diff
- [ ] If this touches the engine, the state the models see, the prompt, the options or the request cadence: replays still match (`pnpm test:determinism`), the PR says what changed, and affected results are rerun
