import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import '@industrial-agent-harness/viewer-builtin/styles.css';
import './style.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
