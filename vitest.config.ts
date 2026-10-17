import { defineConfig } from 'vitest/config'

/**
 * The new suite imports `src/` directly, so it needs no build step.
 *
 * Two projects instead of the old three: the host side (pure folds, projections, channels, and the shared
 * domain maths) runs in Node, and the browser side (data layer, formatting, components) in jsdom. The old
 * per-file 100 % coverage gate was deliberately dropped — it forced test-shaped code and made every
 * refactor a test rewrite — in favour of behaviour-focused suites per layer.
 */
export default defineConfig({
  test: {
    reporters: ['dot'],
    projects: [
      {
        test: {
          name: 'host',
          include: ['tests/host/**/*.spec.ts', 'tests/core/**/*.spec.ts', 'tests/wire/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        logLevel: 'error',
        test: {
          name: 'client',
          include: ['tests/client/**/*.spec.ts'],
          environment: 'jsdom',
          setupFiles: ['tests/client/setup.ts'],
          server: {
            deps: {
              // The primitives dist imports its own .module.css; inlining lets vite transform it.
              inline: ['@deepseek-ai/dsh-client-ui-primitives'],
            },
          },
        },
      },
      {
        // Exercises the BUILT artifacts: the wrapper protocol, the CSS channel and the slot registrations
        // are only observable in `lib/`.
        test: {
          name: 'bundle',
          include: ['tests/bundle/**/*.spec.ts'],
          environment: 'node',
        },
      },
    ],
  },
})
