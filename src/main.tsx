import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ThemeProvider } from './components/ThemeProvider';
import './styles/index.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('39Note could not find its application root.');
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
