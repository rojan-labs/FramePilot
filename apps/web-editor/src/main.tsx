/**
 * @framepilot/web-editor entry — mounts the React app.
 * See plan/PLAN.md Phase 3 (Editor UI).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { LicenseGate } from './license/LicenseGate.js';
import './styles.css';
import './settings-dialog.css';
import './fonts.css';
import './editor-foundation.css';
import './minimal-light-theme.css';
import './components/ai/AiSidebar.beautiful.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('FramePilot: #root element not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <LicenseGate>
      <App />
    </LicenseGate>
  </StrictMode>,
);
