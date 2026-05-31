import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { installCapture } from '@/lib/capture';

// Begin capturing console/network/breadcrumbs at boot so a feedback submission
// carries a redacted diagnostic bundle of what happened before it.
installCapture();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
