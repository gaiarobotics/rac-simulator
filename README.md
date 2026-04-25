# RAC Propagation Simulator

Interactive simulator of Recursive Autonomous Compromise (RAC) dynamics on capability-gated networks. SI propagation over a fixed Erdős–Rényi topology with adjustable inference density (ρ) and transmission probability (p).

## Local development

```sh
npm install
npm run dev
```

## Production build

```sh
npm run build
npm run preview
```

## Deploying to GitHub Pages

1. Create a new GitHub repo named `rac-simulator` (or whatever you want — if you change it, update `base` in `vite.config.js` to match).
2. Push this directory as the initial commit.
3. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
4. Push to `main`. The workflow in `.github/workflows/deploy.yml` builds and deploys automatically.
5. Site lives at `https://<username>.github.io/rac-simulator/`.

## Deploying elsewhere

- **Cloudflare Pages / Vercel / Netlify**: connect the repo, set build command to `npm run build` and output directory to `dist`. Set `base: '/'` in `vite.config.js` if served at domain root.
- **Static file host**: `npm run build` produces a self-contained `dist/` directory. Upload it anywhere.

## Structure

```
src/
  main.jsx            entry point
  RACSimulator.jsx    the component
  index.css           tailwind directives
index.html            html shell
vite.config.js        build config (update `base` for Pages subpath)
tailwind.config.js    tailwind content scanning
.github/workflows/    auto-deploy on push to main
```
