import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// NOTE: `base` must match your GitHub repo name for Pages deploys to work.
// If you rename the repo, update this. For a user-site (username.github.io) use '/'.
export default defineConfig({
  plugins: [react()],
  base: '/rac-simulator/',
});
