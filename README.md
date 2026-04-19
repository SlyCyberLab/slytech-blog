# slytech-blog

Homelab builds, cybersecurity lab work, and infrastructure projects.  
Live at **[blog.slytech.us](https://blog.slytech.us)**

---

## Branches

| Branch | Purpose |
|---|---|
| `main` | **Live Jekyll blog** — deployed to GitHub Pages via the default Pages build. Do not merge untested changes here. |
| `astro-redesign` | **Astro redesign** — full rebuild in Astro 4 with a custom dark terminal UI. Not yet deployed. See below. |

## astro-redesign

A ground-up redesign built with [Astro](https://astro.build), keeping all content and URLs intact.

**Key changes from the Jekyll site:**
- Static Astro 4 site with content collections under `src/content/blog/`
- Custom dark terminal design: matrix rain background, JetBrains Mono + Inter, `#00ff88` accent
- Homepage with category filter and post list
- Post layout with sticky ToC, reading progress bar, and prev/next navigation
- All image paths updated from `/assets/images/` to `/images/`
- CNAME preserved in `public/` so `blog.slytech.us` stays mapped

**To run locally (from `astro-redesign` branch):**
```bash
npm install
npm run dev
```

**To build:**
```bash
npm run build   # outputs to dist/
```

The GitHub Actions workflow (`deploy.yml`) is configured to deploy only on pushes to `main`, so the current Jekyll site remains live until `astro-redesign` is merged.
