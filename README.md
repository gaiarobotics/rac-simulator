# RAC Propagation Simulator

Interactive simulator of Recursive Autonomous Compromise (RAC) dynamics on capability-gated networks. SI propagation over a generated Erdős–Rényi or scale-free topology with adjustable inference density (ρ) and transmission probability (p). Crowd defense prevalence (v) can also be adjusted.

Optional reversal dynamics add a defender state (D). A probed target can commandeer the attacking agent with probability κ per attack attempt and repurpose it as a defender. Defender agents then spread the reversal back through the swarm's own reach: each tick they convert neighboring swarm agents (compromised inference-capable nodes) into further defenders with probability σ, and reclaim neighboring hosts the swarm already compromised (non-inference nodes) with probability η. Lineage reach widens σ beyond direct links: *Direct* (the default) lets a defender also target its whole lineage of compromising agents (parent, grandparent, … back to the seed); *Full (C2)* models a swarm unified by a global C2, where every defender agent reaches every compromised agent each tick; *Off* restricts σ to direct neighbors. Host reclamation always requires a direct link. With κ = σ = η = 0 (the default) the model reduces exactly to SI + reactive-V.

Parameters can be swept to generate scatter plots against the compromise rate.

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
