import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import AuthGate from './components/AuthGate';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><AuthGate><App /></AuthGate></ErrorBoundary></StrictMode>);
