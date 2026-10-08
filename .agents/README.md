# Project Agent Skills

This directory contains project-local skills. Keep all agent files, skills,
and rules exclusively in English, following [AGENTS.md](../AGENTS.md).
Read the relevant `SKILL.md` before applying a skill to a task.

| Skill | Instructions | Source |
| --- | --- | --- |
| Playwright browser diagnostics | [playwright-cli/SKILL.md](skills/playwright-cli/SKILL.md) | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli/tree/main/skills/playwright-cli) |
| Docker and Compose | [docker-expert/SKILL.md](skills/docker-expert/SKILL.md) | [sickn33/agentic-awesome-skills](https://github.com/sickn33/agentic-awesome-skills/tree/main/skills/docker-expert) |
| GitHub Actions workflows | [github-actions-templates/SKILL.md](skills/github-actions-templates/SKILL.md) | [wshobson/agents](https://github.com/wshobson/agents/tree/main/plugins/cicd-automation/skills/github-actions-templates) |
| JavaScript testing | [javascript-testing-patterns/SKILL.md](skills/javascript-testing-patterns/SKILL.md) | [wshobson/agents](https://github.com/wshobson/agents/tree/main/plugins/javascript-typescript/skills/javascript-testing-patterns) |

The skill directories contain copied upstream files, including their referenced
local documentation. They were downloaded and reviewed on October 8, 2026.
Installation does not execute upstream scripts or install runtime dependencies.
The Playwright CLI executable must be available separately when using that skill.

See [the selection guide](../docs/agent-skills.md) for installation commands,
project-specific use cases, and adaptation requirements.
