'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Shield,
  Radio,
  Clock,
  CheckCircle2,
  Plus,
  User as UserIcon,
  LogOut,
  Key,
  Copy,
  Check,
  Cpu,
  Layers,
} from 'lucide-react';
import CameraFeed from '../components/CameraFeed';
import DoorLock from '../components/DoorLock';
import AccessLog from '../components/AccessLog';
import AlertBanner from '../components/AlertBanner';
import AddDeviceModal from '../components/AddDeviceModal';
import RecordedVideos from '../components/RecordedVideos';
import { getMqttClient } from '../lib/mqttClient';
import { useAuth } from '../context/AuthContext';
import {
  DeviceRecord,
  fetchUserDevices,
  createUserDevice,
  deleteUserDevice,
} from '../lib/supabaseClient';

export default function HomePage() {
  const router = useRouter();
  const { user, signOut, isDemo, claimToken, isLoading: authLoading } = useAuth();

  const [currentTime, setCurrentTime] = useState<string>('');
  const [mqttConnected, setMqttConnected] = useState<boolean>(false);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [showProfileMenu, setShowProfileMenu] = useState<boolean>(false);
  const [copiedToken, setCopiedToken] = useState<boolean>(false);

  // Clock updater
  useEffect(() => {
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
    return () => clearInterval(timer);
  }, []);

  // MQTT connection status listener
  useEffect(() => {
    const client = getMqttClient();
    setMqttConnected(client.connected);

    const onConnect = () => setMqttConnected(true);
    const onDisconnect = () => setMqttConnected(false);

    client.on('connect', onConnect);
    client.on('close', onDisconnect);
    client.on('offline', onDisconnect);

    return () => {
      client.off('connect', onConnect);
      client.off('close', onDisconnect);
      client.off('offline', onDisconnect);
    };
  }, []);

  // Fetch user devices
  useEffect(() => {
    const loadDevices = async () => {
      try {
        const data = await fetchUserDevices(user?.id);
        setDevices(data);
      } catch (err) {
        console.error('Failed to load devices:', err);
      }
    };
    if (!authLoading) {
      loadDevices();
    }
  }, [user, authLoading]);

  const handleAddDevice = async (newDev: Omit<DeviceRecord, 'id' | 'created_at'>) => {
    const created = await createUserDevice(newDev, user?.id);
    setDevices((prev) => [...prev, created]);
  };

  const handleDeleteDevice = async (deviceId: string) => {
    if (!confirm('Are you sure you want to unpair this device?')) return;
    try {
      await deleteUserDevice(deviceId, user?.id);
      setDevices((prev) => prev.filter((d) => d.id !== deviceId));
    } catch (err) {
      console.error('Failed to delete device:', err);
      alert('Failed to delete device.');
    }
  };

  const handleCopyClaimToken = () => {
    if (navigator.clipboard && claimToken) {
      navigator.clipboard.writeText(claimToken);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    }
  };

  const cameras = devices.filter((d) => d.device_type === 'camera');
  const doorLocks = devices.filter((d) => d.device_type === 'door_lock');

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
          {/* Pair Device Button */}
          <button
            type="button"
            className="btn-add-device"
            onClick={() => setIsModalOpen(true)}
            title="Pair New ESP32 Device"
          >
            <Plus size={14} />
            <span>Pair Device</span>
          </button>

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

          {/* User Profile / Auth Pill */}
          <div className="user-profile-wrapper">
            {user ? (
              <div className="profile-pill-container">
                <button
                  type="button"
                  className="profile-pill"
                  onClick={() => setShowProfileMenu(!showProfileMenu)}
                  title="Account settings & claim token"
                >
                  <UserIcon size={14} />
                  <span className="user-label">
                    {isDemo ? 'Demo Mode' : user.email?.split('@')[0] || 'Account'}
                  </span>
                </button>

                {showProfileMenu && (
                  <div className="profile-dropdown">
                    <div className="profile-dropdown-header">
                      <span className="dropdown-email">{user.email || 'Demo User'}</span>
                      <span className="dropdown-badge">{isDemo ? 'Local Demo' : 'Cloud Connected'}</span>
                    </div>

                    <div className="profile-token-box">
                      <div className="token-label">
                        <Key size={12} />
                        <span>Pairing Claim Token</span>
                      </div>
                      <div className="token-row">
                        <code className="token-code">{claimToken}</code>
                        <button
                          type="button"
                          onClick={handleCopyClaimToken}
                          className="copy-icon-btn"
                          title="Copy Claim Token"
                        >
                          {copiedToken ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
                        </button>
                      </div>
                    </div>

                    <div className="dropdown-actions">
                      <button
                        type="button"
                        className="dropdown-item logout-btn"
                        onClick={async () => {
                          setShowProfileMenu(false);
                          await signOut();
                          router.push('/login');
                        }}
                      >
                        <LogOut size={14} />
                        <span>{isDemo ? 'Exit Demo Mode' : 'Sign Out'}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                className="btn-login-nav"
                onClick={() => router.push('/login')}
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Dashboard Workspace */}
      <div className="dashboard-container">
        {/* Real-Time Security Alerts */}
        <AlertBanner claimToken={claimToken} userId={user?.id} />

        {/* Dynamic Multi-Column Grid */}
        <div className="dashboard-grid">
          {/* Main Surveillance Feed Column */}
          <div className="main-column">
            {cameras.length > 0 ? (
              <div className="cameras-grid">
                {cameras.map((cam) => (
                  <CameraFeed
                    key={cam.id}
                    deviceId={cam.device_uid}
                    deviceName={cam.name}
                    initialStreamUrl={cam.stream_url}
                    topicPrefix={claimToken ? `users/${claimToken}/cameras/${cam.device_uid}` : undefined}
                    onDelete={() => handleDeleteDevice(cam.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-devices-card">
                <div className="empty-icon-wrap">
                  <Cpu size={32} />
                </div>
                <h3>No Cameras Registered</h3>
                <p>
                  Connect your ESP32-CAM to your account by pairing a new device with your Claim Token.
                </p>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setIsModalOpen(true)}
                >
                  <Plus size={16} />
                  <span>Pair Your First Camera</span>
                </button>
              </div>
            )}

            {/* ── Detection Recordings Panel (below camera views) ── */}
            {cameras.map((cam) => (
              <RecordedVideos
                key={`recordings-${cam.id}`}
                deviceId={cam.device_uid}
                deviceName={cam.name}
                relayUrl={cam.stream_url ? cam.stream_url.replace('/stream', '') : ''}
                topicPrefix={claimToken ? `users/${claimToken}/cameras/${cam.device_uid}` : undefined}
              />
            ))}
            {cameras.length === 0 && (
              <RecordedVideos
                deviceId="ESP32_CAM_01"
                deviceName="Front Entrance Camera"
              />
            )}
          </div>

          {/* Access Control & Activity Logs Column */}
          <div className="side-column">
            {doorLocks.length > 0 ? (
              doorLocks.map((lock) => (
                <DoorLock
                  key={lock.id}
                  deviceId={lock.device_uid}
                  deviceName={lock.name}
                  topicPrefix={claimToken ? `users/${claimToken}/doors/${lock.device_uid}` : undefined}
                  onDelete={() => handleDeleteDevice(lock.id)}
                />
              ))
            ) : (
              <div className="empty-locks-card">
                <Layers size={22} />
                <span>No access nodes paired. Click &apos;Pair Device&apos; to add a door lock.</span>
              </div>
            )}

            <AccessLog claimToken={claimToken} userId={user?.id} />
          </div>
        </div>
      </div>

      {/* Add Device Modal */}
      <AddDeviceModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAddDevice={handleAddDevice}
        claimToken={claimToken}
      />
    </main>
  );
}
