import { defineConfig, Plugin } from 'vitest/config';
import { readFileSync } from 'fs';

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
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/**/*.ts'],
      exclude: ['lib/handlers/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '../config.yaml': './config.yaml',
    },
  },
});
