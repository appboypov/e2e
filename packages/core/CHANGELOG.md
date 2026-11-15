# @e2e-dev/core

## 0.23.2

### Patch Changes

- [#1737](https://github.com/e2e-inc/e2e/pull/1737) [`0a5ee16`](https://github.com/e2e-inc/e2e/commit/0a5ee16387cf213df547a8422b7d690675744986) Thanks [@kdy1](https://github.com/kdy1)! - New package `@e2e-dev/core`: the engine contract, locators, agent, replay cache, and engine sessions that `e2e` is built on. `e2e` depends on it at the same version, and `e2e/engine` and `e2e/agent` re-export it unchanged. `@e2e-dev/web` and `@e2e-dev/mobile` peer on `@e2e-dev/core` beside `e2e`, and import the contract from `@e2e-dev/core/engine`, which a third-party engine can now import too. npm, pnpm and Bun install the new peer themselves. A Yarn project lists `@e2e-dev/core` beside the engine; `e2e init` and `e2e upgrade` add it.
