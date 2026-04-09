import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MedplumProvider } from '@medplum/react';
import { MockClient } from '@medplum/mock';
import '@medplum/react/styles.css';
import './index.css';
import App from './App.tsx';

// MockClient lets the demo run with no real Medplum backend.
// Replace with `new MedplumClient({ baseUrl, clientId })` for production.
const medplum = new MockClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MedplumProvider medplum={medplum}>
      <App />
    </MedplumProvider>
  </StrictMode>,
);
