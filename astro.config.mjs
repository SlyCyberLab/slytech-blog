import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://blog.slytech.us',
  output: 'static',
  integrations: [],
  markdown: {
    shikiConfig: {
      theme: 'one-dark-pro',
      wrap: true,
    },
  },
});
