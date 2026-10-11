import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * Note: intentionally not wrapped in <StrictMode>. This app owns long-lived
 * media resources (camera stream, microphone AudioWorklet, a websocket to the
 * Live API); StrictMode's double mount/unmount in development tears those down
 * mid-session and produces misleading camera/audio errors.
 */
const container = document.getElementById('root');
if (!container) throw new Error('Root container missing from index.html');

createRoot(container).render(<App />);
