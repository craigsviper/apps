// SweepAreas — wraps the v12.2 Sweeping component, defaulting to the 'areas' tab.
// Full Areas & Roads CRUD (add/edit/delete areas, add/edit/delete roads) is embedded in SweepJobs.
import SweepJobsFull from './SweepJobs';
export default function SweepAreas() {
  return <SweepJobsFull initialTab="areas" />;
}
