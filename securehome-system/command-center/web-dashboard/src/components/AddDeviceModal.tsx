'use client';

import React, { useState } from 'react';
import { X, Camera, Lock, Check, Copy, Cpu, Info } from 'lucide-react';
import { DeviceRecord } from '../lib/supabaseClient';

interface AddDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddDevice: (device: Omit<DeviceRecord, 'id' | 'created_at'>) => Promise<void>;
  claimToken: string;
}

export const AddDeviceModal: React.FC<AddDeviceModalProps> = ({
  isOpen,
  onClose,
  onAddDevice,
  claimToken,
}) => {
  const [deviceType, setDeviceType] = useState<'camera' | 'door_lock'>('camera');
  const [name, setName] = useState('');
  const [deviceUid, setDeviceUid] = useState('');
  const [streamUrl, setStreamUrl] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCopyToken = () => {
    if (navigator.clipboard && claimToken) {
      navigator.clipboard.writeText(claimToken);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !deviceUid.trim()) {
      setErrorMsg('Device name and UID are required.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      await onAddDevice({
        name: name.trim(),
        device_type: deviceType,
        device_uid: deviceUid.trim(),
        stream_url: deviceType === 'camera' ? streamUrl.trim() || 'http://192.168.1.145:81/stream' : undefined,
        status: 'online',
      });
      // Reset
      setName('');
      setDeviceUid('');
      setStreamUrl('');
      onClose();
    } catch (err: unknown) {
      setErrorMsg((err as Error)?.message || 'Failed to register device.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-container">
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-title-wrap">
            <Cpu size={20} className="modal-title-icon" />
            <div>
              <h3>Pair New Device</h3>
              <p className="modal-subtitle">Connect an ESP32 camera or door lock node to your account</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="modal-close-btn" aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        {/* Claim Token Callout */}
        <div className="claim-token-card">
          <div className="claim-token-header">
            <Info size={14} />
            <span>Your Account Claim Token</span>
          </div>
          <div className="claim-token-box">
            <code className="claim-token-value">{claimToken || 'demo-claim-token'}</code>
            <button
              type="button"
              onClick={handleCopyToken}
              className="copy-token-btn"
              title="Copy Claim Token to clipboard"
            >
              {copiedToken ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
              <span>{copiedToken ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <p className="claim-token-help">
            Enter this code into the ESP32 setup portal (SoftAP) so hardware messages are routed to your account.
          </p>
        </div>

        {errorMsg && <div className="modal-alert error">{errorMsg}</div>}

        {/* Device Registration Form */}
        <form onSubmit={handleSubmit} className="modal-form">
          {/* Device Type Selectors */}
          <div className="form-group">
            <label>Device Type</label>
            <div className="device-type-grid">
              <button
                type="button"
                className={`device-type-card ${deviceType === 'camera' ? 'selected' : ''}`}
                onClick={() => setDeviceType('camera')}
              >
                <Camera size={22} />
                <span className="type-title">Vision Node</span>
                <span className="type-desc">ESP32-CAM MJPEG Video Stream</span>
              </button>

              <button
                type="button"
                className={`device-type-card ${deviceType === 'door_lock' ? 'selected' : ''}`}
                onClick={() => setDeviceType('door_lock')}
              >
                <Lock size={22} />
                <span className="type-title">Access Node</span>
                <span className="type-desc">ESP32 RFID & Relay Door Lock</span>
              </button>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="devName">Device Name</label>
            <input
              id="devName"
              type="text"
              placeholder={deviceType === 'camera' ? 'e.g. Front Porch Camera' : 'e.g. Front Door Lock'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="devUid">Hardware Identifier / UID</label>
            <input
              id="devUid"
              type="text"
              placeholder="e.g. ESP32_CAM_01 or MAC Address"
              value={deviceUid}
              onChange={(e) => setDeviceUid(e.target.value)}
              required
            />
            <span className="field-hint">Unique identifier programmed on the ESP32 node.</span>
          </div>

          {deviceType === 'camera' && (
            <div className="form-group">
              <label htmlFor="devStream">Initial Stream URL (Optional)</label>
              <input
                id="devStream"
                type="text"
                placeholder="http://192.168.1.145:81/stream (auto-updated by MQTT discovery)"
                value={streamUrl}
                onChange={(e) => setStreamUrl(e.target.value)}
              />
            </div>
          )}

          {/* Form Actions */}
          <div className="modal-actions">
            <button type="button" onClick={onClose} className="btn-secondary" disabled={isSubmitting}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Registering...' : 'Register Device'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
export default AddDeviceModal;
