import React from 'react';
import { Shield } from 'lucide-react';
import CameraFeed from '../components/CameraFeed';
import DoorLock from '../components/DoorLock';
import AccessLog from '../components/AccessLog';
import AlertBanner from '../components/AlertBanner';

export default function HomePage() {
  return (
    <main>
      <header className="header-bar">
        <div className="brand-wrapper">
          <Shield className="brand-icon" size={28} />
          <h1>SecureHome Command Center</h1>
        </div>
        <div className="system-status-indicator">
          <span className="pulse-dot" />
          <span>System Active</span>
        </div>
      </header>

      <div className="dashboard-container">
        <AlertBanner />

        <div className="dashboard-grid">
          <div className="main-column">
            <CameraFeed />
          </div>

          <div className="side-column">
            <DoorLock />
            <AccessLog />
          </div>
        </div>
      </div>
    </main>
  );
}
