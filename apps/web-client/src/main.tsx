import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { BrandProvider } from './branding/useBrand.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/fields.css';

const container = document.getElementById('duefold');
if (container === null) throw new Error('application container is missing');
createRoot(container).render(
  <StrictMode>
    <BrandProvider>
      <App />
    </BrandProvider>
  </StrictMode>,
);
