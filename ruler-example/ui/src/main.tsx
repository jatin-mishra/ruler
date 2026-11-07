import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, savedTheme } from './hooks';
import { ToastProvider } from './ui';
import './styles.css';

applyTheme(savedTheme()); // before the first paint, so there is no flash

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
