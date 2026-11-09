# Журнал змін

У цьому файлі описуються помітні зміни кожної версії проєкту.

## [1.2.0](https://github.com/VaLeXaR/dtek-monitor/compare/v1.1.0...v1.2.0) (2026-11-09)


### Можливості

* filter DTEK notices by Kyiv area using LLM ([507e141](https://github.com/VaLeXaR/dtek-monitor/commit/507e141b141fef88b4d8ec98e3cb1cc3c98eecc7))
* improve monitoring reliability and state handling ([745d083](https://github.com/VaLeXaR/dtek-monitor/commit/745d0833327e70365c500831c9d233dcb4b1a16b))
* keep only address emergency outage alerts ([57ec300](https://github.com/VaLeXaR/dtek-monitor/commit/57ec300f65f7ad6cb17cf607bd7b0d4345c3d9e5))
* manage outage cancellation notifications ([c77302b](https://github.com/VaLeXaR/dtek-monitor/commit/c77302ba4380b9212963a9cc279b99313fdb40ba))
* replace changed outage notifications ([8be2b99](https://github.com/VaLeXaR/dtek-monitor/commit/8be2b99acfb91c12077a9754a35fb7570ed94bfe))


### Виправлення

* detect additional emergency outage notices ([b24a240](https://github.com/VaLeXaR/dtek-monitor/commit/b24a24064e6ba772b22de669b8e2604e4a67a95e))
* make browser session storage writable in Docker ([0519dd0](https://github.com/VaLeXaR/dtek-monitor/commit/0519dd017d0ae0d424086597d44bebb184604119))
* preserve DTEK browser sessions and use native outage form ([ee1aa29](https://github.com/VaLeXaR/dtek-monitor/commit/ee1aa29d8a27a46f33395cab17479252b9b0dd30))
* report actionable LLM errors without exposing secrets ([5e0462e](https://github.com/VaLeXaR/dtek-monitor/commit/5e0462e14ac36eb100f4752bf1d3dac2ad071226))
* reuse unchanged notice LLM decisions throughout Kyiv day ([b6962f2](https://github.com/VaLeXaR/dtek-monitor/commit/b6962f2cddf08061e986ec3a7fd556ded2cfe2bc))

## 1.1.0 — 17 листопада 2025

- Винесено константи та допоміжні функції в окремі модулі.
- Додано перевірку запланованих відключень.
- Оновлено версію Node.js і документацію.
