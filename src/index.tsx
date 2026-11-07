import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import MusicBoxSheetGenerator from './MusicBoxSheetGenerator';

ReactDOM.render(
  <React.StrictMode>
    <MusicBoxSheetGenerator />
  </React.StrictMode>,
  document.getElementById('root')
);

// Earlier versions of the app could have installed a service worker: remove it so that
// visitors always get the latest version.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(registrations => registrations.forEach(registration => registration.unregister()))
    .catch(() => undefined);
}
