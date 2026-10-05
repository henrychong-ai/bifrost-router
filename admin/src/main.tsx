// First import on purpose: zod must be jitless before any schema module loads.
// biome-ignore assist/source/organizeImports: zod-jitless must stay the first import (zod-jitless.test.ts)
import { isZodJitless } from '@/lib/zod-jitless';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { installCapture } from '@/lib/capture';
import App from './App.tsx';

// Begin capturing console/network/breadcrumbs at boot so a feedback submission
// carries a redacted diagnostic bundle of what happened before it.
installCapture();

// Non-fatal: the capture buffer keeps this for feedback reports; boot continues.
if (!isZodJitless()) console.error('zod is not jitless: its eval probe will hit the CSP');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
