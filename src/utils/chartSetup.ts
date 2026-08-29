/**
 * chartSetup.ts — Single registration point for Chart.js components.
 *
 * Chart.js v4 is tree-shakeable: you must explicitly register every
 * controller, element, scale and plugin you use.  We do that once here
 * so both Dashboard.tsx and SweepReports.tsx can simply:
 *
 *   import { Chart } from '../utils/chartSetup';
 *
 * and use `Chart` directly — no CDN, no dynamic <script> injection,
 * works completely offline and is never blocked by Firefox ETP.
 */
import {
  Chart,
  // Controllers
  BarController,
  LineController,
  PieController,
  DoughnutController,
  // Elements
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  // Scales
  CategoryScale,
  LinearScale,
  // Plugins
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';

// v73.46 — Craig's console logs: "Tried to use the 'fill' option without
// the 'Filler' plugin enabled" firing on every chart render (Dashboard.tsx
// and SweepReports.tsx both set `fill: true`/`fill: type==='line'` on a
// line dataset). Chart.js v4 is tree-shakeable — the `fill` option doesn't
// work at all without this plugin explicitly registered, so every affected
// chart was silently rendering with NO shaded area under the line at all,
// re-throwing this warning on every single update/resize (matching the
// repeated `initialize`/`buildOrUpdateControllers` stack in the logs — one
// hit per re-render, not a one-off). Registering it here, in the shared
// setup both files already import `Chart` from, fixes every affected chart
// at once with no per-chart-file change needed.
Chart.register(
  BarController, LineController, PieController, DoughnutController,
  BarElement, LineElement, PointElement, ArcElement,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler,
);

export { Chart };
