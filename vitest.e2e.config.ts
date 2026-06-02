import { defineConfig, Plugin } from 'vitest/config';
import { readFileSync } from 'fs';

// Same YAML-as-text loader the main config uses, so lib/config.ts can
// `import '../config.yaml'` and load the real config in tests.
function yamlTextPlugin(): Plugin {
  return {
    name: 'yaml-text',
    transform(_code: string, id: string) {
      if (id.endsWith('.yaml') || id.endsWith('.yml')) {
        const content = readFileSync(id, 'utf-8');
        return { code: `export default ${JSON.stringify(content)};`, map: null };
      }
    },
  };
}

export default defineConfig({
  plugins: [yamlTextPlugin()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    setupFiles: ['tests/e2e/setup.ts'],
    // Pin the process timezone so DATE→string conversion (lib/prompt toDateString,
    // which uses local-time accessors, matching Neon) is deterministic.
    env: { TZ: 'UTC' },
  },
  resolve: {
    alias: {
      '../config.yaml': './config.yaml',
    },
  },
});
