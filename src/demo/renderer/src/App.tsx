import type { JSX } from 'react';
import { DashboardApp } from './DashboardApp.js';
import { OverlayApp } from './OverlayApp.js';

export function App(): JSX.Element {
  const view = new URLSearchParams(window.location.search).get('view');
  return view === 'overlay' ? <OverlayApp /> : <DashboardApp />;
}
