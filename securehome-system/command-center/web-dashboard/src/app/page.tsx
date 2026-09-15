'use client';

import React, { useEffect, useState } from 'react';
import { Shield, Radio, Clock, CheckCircle2 } from 'lucide-react';
import CameraFeed from '../components/CameraFeed';
import DoorLock from '../components/DoorLock';
import AccessLog from '../components/AccessLog';
import AlertBanner from '../components/AlertBanner';
import { getMqttClient } from '../lib/mqttClient';

export default function HomePage() {
  const [currentTime, setCurrentTime] = useState<string>('');
  const [mqttConnected, setMqttConnected] = useState<boolean>(false);

  useEffect(() => {
    // Clock updater
    const updateClock = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
    };
    updateClock();
    const timer = setInterval(updateClock, 1000);

    // MQTT connection status listener
    const client = getMqttClient();
    setMqttConnected(client.connected);

    const onConnect = () => setMqttConnected(true);
    const onDisconnect = () => setMqttConnected(false);

    client.on('connect', onConnect);
    client.on('close', onDisconnect);
    client.on('offline', onDisconnect);

    return () => {
      clearInterval(timer);
      client.off('connect', onConnect);
      client.off('close', onDisconnect);
      client.off('offline', onDisconnect);
    };
  }, []);

  return (
    <main className="dashboard-root">
      {/* Top Application Header */}
      <header className="header-bar">
        <div className="brand-wrapper">
          <div className="brand-icon-box">
            <Shield size={18} />
          </div>
          <div className="brand-text">
            <h1>SecureHome</h1>
            <span className="brand-tag">COMMAND CENTER</span>
          </div>
        </div>

        <div className="header-telemetry">
          {/* MQTT Broker Status Pill */}
          <div
            className={`telemetry-item broker-pill ${
              mqttConnected ? 'broker-online' : 'broker-offline'
            }`}
          >
            <Radio size={13} className={mqttConnected ? 'pulse-icon' : ''} />
            <span>MQTT {mqttConnected ? 'CONNECTED' : 'DISCONNECTED'}</span>
          </div>

          {/* System Mode Pill */}
          <div className="telemetry-item system-mode-pill">
            <CheckCircle2 size={13} />
            <span>SYSTEM ARMED</span>
          </div>

          {/* Live Tabular Clock */}
          {currentTime && (
            <div className="telemetry-item clock-pill" title="Local System Time">
              <Clock size={13} />
              <span className="clock-digits">{currentTime}</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Dashboard Workspace */}
      <div className="dashboard-container">
        {/* Real-Time Security Alerts */}
        <AlertBanner />

        {/* Dynamic Multi-Column Grid */}
        <div className="dashboard-grid">
          {/* Main Surveillance Feed Column */}
          <div className="main-column">
            <CameraFeed />
          </div>

          {/* Access Control & Activity Logs Column */}
          <div className="side-column">
            <DoorLock />
            <AccessLog />
          </div>
        </div>
      </div>
    </main>
  );
}
