import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    // Global fetch throws: no test may call a real API (test/setup/no-network.ts).
    setupFiles: ['test/setup/no-network.ts'],
  },
});
