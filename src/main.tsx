import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles.css';

if (import.meta.env.DEV) {
  // E2E/debug access to the store and actions in development builds only.
  import('./state/store').then((m) => {
    (window as unknown as { __tileStudio: typeof m }).__tileStudio = m;
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
