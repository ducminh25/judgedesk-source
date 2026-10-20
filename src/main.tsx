import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import StartupFailure from './components/StartupFailure.js';
import './index.css';
import './i18n';

import { ThemeProvider } from './contexts/ThemeContext';
import { initializeApiPort } from './api.js';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing JudgeDesk root element');
}

const root = createRoot(rootElement);

function renderApplication() {
  root.render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>,
  );
}

function renderStartupFailure(retrying: boolean) {
  root.render(
    <StrictMode>
      <ThemeProvider>
        <StartupFailure retrying={retrying} onRetry={() => void startApplication(true)} />
      </ThemeProvider>
    </StrictMode>,
  );
}

async function startApplication(isRetry = false) {
  if (isRetry) {
    renderStartupFailure(true);
  }

  try {
    await initializeApiPort();
    renderApplication();
  } catch (error) {
    console.error('JudgeDesk backend initialization failed', error);
    renderStartupFailure(false);
  }
}

void startApplication();
