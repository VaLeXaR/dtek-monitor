# Agent Instructions

## Language policy

All agent-facing files, skills, and rules must be written exclusively in English.
This includes root and nested `AGENTS.md` files, `SKILL.md` files and their
supporting agent instructions, rule files, agent configuration documentation,
and `docs/agent-skills.md`. Apply this policy when creating or updating these
files, and check their language before completing the task.

Communicate with the user in Ukrainian unless they request another language.
Keep user-facing documentation and notification messages in Ukrainian.

## Project

DTEK Monitor checks power outages for an address in Kyiv and sends or updates
Telegram notifications.

Stack: Node.js 22, JavaScript ES modules, Playwright Chromium, built-in `fetch`,
Docker Compose, and GitHub Actions. Check `.nvmrc` and `package.json` for the
Node.js version. The project has no compilation step.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/monitor.js` | Browser automation, DTEK requests, outage detection, Telegram API, and a single monitoring run |
| `src/helpers.js` | JSON state persistence and date/text formatting |
| `src/constants.js` | Environment variables, the DTEK URL, and state file paths |
| `test/*.test.js` | Isolated `node:test` coverage for monitor behavior and state helpers |
| `artifacts/last-message.json` | Last Telegram message state: `message_id` and `date` |
| `artifacts/emergency-outages.json` | General emergency outage notice state: `active`; created at runtime |
| `docker-entrypoint.sh` | Monitoring loop, interval, signal handling, and execution of supplied commands |
| `Dockerfile`, `compose.yaml`, `.dockerignore` | Chromium image, container configuration, and persistent state volume |
| `.github/workflows/monitor.yml` | Checks every 10 minutes and commits updated state to the repository |
| `.env.example` | Configuration template without secrets |
| `README.md` | User setup and usage documentation |

## Workflow and code style

- Read the relevant files and check `git status --short` before making changes.
  Preserve existing user changes and keep the diff within the task's scope.
- Use npm and `package-lock.json`. Use `npm ci` for reproducible installation;
  install Chromium with `npx playwright install chromium`.
- Follow `.prettierrc.json`: two-space indentation, no semicolons, double quotes,
  and ES5 trailing commas. Avoid unrelated formatting changes.
- Preserve ES modules, `.js` extensions in local imports, and the `node:` prefix
  for built-in modules. Prefer built-in Node.js APIs.
- Add dependencies only for a concrete need; update the lockfile together with
  `package.json`. Adapt skill templates to this small monitoring script.
- Update `README.md` and, when relevant, `.env.example` when changing
  configuration, startup, or notification behavior. Do not overwrite an
  existing `.env` file.

## Behavior to account for

- Monitoring supports Kyiv. Preserve the browser context for `/ua/ajax`
  requests, CSRF token retrieval, and browser cleanup in `finally`.
- The general emergency outage notice takes priority over address-specific
  requests. When it disappears, delete its Telegram notification without
  sending a cancellation message; reset `active` only after successful deletion.
- Address-specific notifications cover emergency and unscheduled outage
  categories. Scheduled outages must not trigger notifications.
- Edit an existing message from the current day. Clear previous-day state
  according to the calendar date in `Europe/Kyiv`. Format user-facing dates
  in the same time zone.
- Telegram uses `parse_mode: "HTML"`. When changing message generation,
  account for escaping external data and address values.
- Preserve JSON state compatibility and first-run behavior without state
  files. Do not modify live `artifacts/` as a side effect of code validation.
- The local script performs a single check. In Docker, the
  `CHECK_INTERVAL_SECONDS` delay starts after the check completes
  (600 seconds by default). GitHub Actions runs separate checks on a cron.
- Docker runs as the `node` user and stores state in
  `monitor-state:/app/artifacts`. Account for write permissions, Chromium
  compatibility with the base image, and process shutdown on `TERM`/`INT`.

## Validation

Check syntax without running the monitor:

```bash
node --check src/constants.js
node --check src/helpers.js
node --check src/monitor.js
sh -n docker-entrypoint.sh
git diff --check
```

For Compose changes, when Docker and the required environment files are
available, use `docker compose config --quiet` to avoid printing secret values.
For Dockerfile changes, validate the build with `docker compose build` when
Docker daemon and network access are available. Starting the container is a
separate action.

`package.json` provides `start`, `test`, and `watch`; there are no `lint` or
`build` commands. Report only checks that actually ran; syntax checks do not
validate logic. For logic changes, add focused checks using `node:test`, with
mocked browser, `fetch`, and time, plus a temporary state directory.
Documentation-only changes do not need new tests.

Relevant scenarios: no outage; scheduled, unscheduled, or emergency outages;
appearance and cancellation of the general notice; day rollover in Kyiv;
a missing house in the DTEK response; HTTP/Telegram errors; and missing or
corrupted state.

## External services and secrets

- `npm start`, `npm run watch`, `node src/monitor.js`, and starting the Compose
  service contact DTEK, may send, edit, or delete Telegram messages, and update
  state. Importing `src/monitor.js` also starts a check. Use isolated mocks for
  routine validation; run live checks when they are within the user's request.
- Do not print or commit `.env`, tokens, private addresses, or full Telegram
  URLs containing tokens. Use fictional values in examples.
- Do not run multiple monitors against the same state concurrently. Do not
  delete `monitor-state` for testing: `docker compose down -v` removes it.
- The current workflow commits `artifacts/`, may amend the latest commit,
  and runs `push --force-with-lease` to `main`. Account for these actions when
  modifying it; do not trigger it for routine documentation validation.

## Skills

Project-local skills are installed in `.agents/skills/`. Read the relevant
`SKILL.md` before applying a skill:

- [playwright-cli](.agents/skills/playwright-cli/SKILL.md): inspect the DTEK page,
  DOM, selectors, and network requests.
- [docker-expert](.agents/skills/docker-expert/SKILL.md): change the image,
  Compose setup, volume, or container lifecycle.
- [github-actions-templates](.agents/skills/github-actions-templates/SKILL.md):
  change workflows, caching, or permissions.
- [javascript-testing-patterns](.agents/skills/javascript-testing-patterns/SKILL.md):
  isolate logic checks and external API calls.

Sources and installation details: [.agents/README.md](.agents/README.md) and
[docs/agent-skills.md](docs/agent-skills.md).

Skills supplement these instructions and are not monitor dependencies.
Their absence does not block work. Apply examples with other Node.js versions,
test frameworks, or services only when the current task requires them.
