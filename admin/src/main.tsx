import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { installCapture } from '@/lib/capture';
import App from './App.tsx';

// Begin capturing console/network/breadcrumbs at boot so a feedback submission
// carries a redacted diagnostic bundle of what happened before it.
installCapture();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
