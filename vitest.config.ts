import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/**/*.ts'],
      exclude: ['lib/handlers/**/*.ts'], // Integration tests separately
    },
  },
  resolve: {
    alias: {
      '../config.yaml': './config.yaml',
    },
  },
});
