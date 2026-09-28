'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, Trash2, Clock, Download, X, RefreshCw } from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';

export interface RetentionOption {
  label: string;
  valueSeconds: number;
}

export const RETENTION_OPTIONS: RetentionOption[] = [
  { label: '1 min (Testing)', valueSeconds: 60 },
  { label: '30 days', valueSeconds: 30 * 24 * 60 * 60 },
  { label: '45 days', valueSeconds: 45 * 24 * 60 * 60 },
  { label: '60 days', valueSeconds: 60 * 24 * 60 * 60 },
];

export const DEFAULT_RETENTION_SECONDS = 60;

export const getRetentionLabel = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

interface DetectionSnapshot {
  id: string;
  deviceId: string;
  filename: string;
  snapshotUrl: string;
  timestamp: string;
  createdAt: number;
  confidence: number;
}

interface RecordedVideosProps {
  deviceId?: string;
  deviceName?: string;
  relayUrl?: string;
  topicPrefix?: string;
}

const resolveSnapshotUrl = (url: string, relayUrl: string) => {
  if (/^https?:\/\//i.test(url)) return url;
  const path = url.startsWith('/') ? url : `/${url}`;
  const savedRelay = typeof window === 'undefined'
    ? ''
    : localStorage.getItem('securehome_camera_relay_url') || '';
  try {
    return new URL(path, relayUrl || savedRelay).toString();
  } catch {
    return path;
  }
};

export const RecordedVideos: React.FC<RecordedVideosProps> = ({
  deviceId = 'ESP32_CAM_01',
  deviceName = 'Front Entrance Camera',
  relayUrl = '',
  topicPrefix,
}) => {
  const [snapshots, setSnapshots] = useState<DetectionSnapshot[]>([]);
  const [selected, setSelected] = useState<DetectionSnapshot | null>(null);
  const [retentionSeconds, setRetentionSeconds] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_RETENTION_SECONDS;
    return Number(localStorage.getItem('securehome_retention_duration')) || DEFAULT_RETENTION_SECONDS;
  });

  const fetchSnapshots = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/recordings?device_uid=${encodeURIComponent(deviceId)}&retention_seconds=${retentionSeconds}`
      );
      if (!response.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.snapshots)) return;

      const loaded: DetectionSnapshot[] = data.snapshots.map((snapshot: any) => ({
        id: snapshot.id,
        deviceId: snapshot.device_uid || deviceId,
        filename: snapshot.filename || `${snapshot.id}.jpg`,
        snapshotUrl: resolveSnapshotUrl(snapshot.snapshot_url || '', relayUrl),
        timestamp: snapshot.timestamp || new Date().toISOString(),
        createdAt: snapshot.created_at ? new Date(snapshot.created_at).getTime() : Date.now(),
        confidence: snapshot.confidence || 0,
      }));
      setSnapshots((previous) => {
        const unique = new Map<string, DetectionSnapshot>();
        [...loaded, ...previous].forEach((snapshot) => unique.set(snapshot.id, snapshot));
        return Array.from(unique.values()).sort((a, b) => b.createdAt - a.createdAt);
      });
    } catch {
      // The processor API may be unreachable when the dashboard is hosted remotely.
    }
  }, [deviceId, relayUrl, retentionSeconds]);

  useEffect(() => {
    void fetchSnapshots();
    const refreshTimer = setInterval(() => void fetchSnapshots(), 10000);
    const expiryTimer = setInterval(() => {
      const cutoff = Date.now() - retentionSeconds * 1000;
      setSnapshots((previous) => previous.filter((snapshot) => snapshot.createdAt > cutoff));
      setSelected((current) => current && current.createdAt > cutoff ? current : null);
    }, 1000);
    return () => {
      clearInterval(refreshTimer);
      clearInterval(expiryTimer);
    };
  }, [fetchSnapshots, retentionSeconds]);

  useEffect(() => {
    const client = getMqttClient();
    const subscribe = () => {
      client.subscribe('security/alerts/person');
      if (topicPrefix) client.subscribe(`${topicPrefix}/alerts/person`);
    };
    const onMessage = (topic: string, message: Buffer) => {
      if (topic !== 'security/alerts/person' && !topic.endsWith('/alerts/person')) return;
      try {
        const payload = JSON.parse(message.toString());
        if (!payload.snapshot_url) return;
        if (payload.camera && payload.camera !== deviceId && payload.camera !== 'cam_front_door') return;
        const id = payload.snapshot_id || `snap_${Date.now()}`;
        const snapshot: DetectionSnapshot = {
          id,
          deviceId: payload.camera || deviceId,
          filename: payload.snapshot_url.split('/').pop() || `${id}.jpg`,
          snapshotUrl: resolveSnapshotUrl(payload.snapshot_url, relayUrl),
          timestamp: payload.timestamp || new Date().toISOString(),
          createdAt: Date.now(),
          confidence: payload.confidence || 0,
        };
        setSnapshots((previous) => previous.some((item) => item.id === id) ? previous : [snapshot, ...previous]);
      } catch {
        // Ignore malformed MQTT payloads.
      }
    };

    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('message', onMessage);
    return () => {
      client.off('connect', subscribe);
      client.off('message', onMessage);
    };
  }, [deviceId, relayUrl, topicPrefix]);

  const updateRetention = (value: number) => {
    setRetentionSeconds(value);
    localStorage.setItem('securehome_retention_duration', String(value));
    const client = getMqttClient();
    if (!client.connected) return;
    const payload = JSON.stringify({ retention_seconds: value, device_uid: deviceId });
    client.publish('security/camera/settings/retention', payload, { qos: 1, retain: true });
    if (topicPrefix) client.publish(`${topicPrefix}/settings/retention`, payload, { qos: 1, retain: true });
  };

  const deleteSnapshot = async (id: string) => {
    setSnapshots((previous) => previous.filter((snapshot) => snapshot.id !== id));
    setSelected(null);
    try {
      await fetch(`/api/recordings?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      // The snapshot may already have expired or the processor may be offline.
    }
  };

  return (
    <section className="recorded-videos-section" aria-label="Person detection snapshots">
      <header className="recorded-videos-header">
        <div className="recorded-videos-title">
          <div className="record-pulse-badge"><ImageIcon size={14} /></div>
          <div>
            <h4>Person snapshots</h4>
            <span className="recorded-videos-subtitle">Auto-saved photos on detection</span>
          </div>
        </div>
        <div className="recorded-videos-controls">
          <label className="retention-dropdown-wrapper" title="Snapshot auto-delete time">
            <Clock size={12} />
            <span>Auto-delete</span>
            <select value={retentionSeconds} onChange={(event) => updateRetention(Number(event.target.value))}>
              {RETENTION_OPTIONS.map((option) => (
                <option key={option.valueSeconds} value={option.valueSeconds}>{option.label}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-icon btn-refresh-recordings" onClick={() => void fetchSnapshots()} title="Refresh snapshots">
            <RefreshCw size={13} />
          </button>
        </div>
      </header>

      {snapshots.length ? (
        <div className="recordings-grid">
          {snapshots.map((snapshot) => (
            <article key={snapshot.id} className="recording-card" onClick={() => setSelected(snapshot)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="recording-thumb-img" src={snapshot.snapshotUrl} alt={`Person detected at ${new Date(snapshot.timestamp).toLocaleString()}`} />
              <div className="recording-card-body">
                <span className="recording-timestamp"><Clock size={11} /> {new Date(snapshot.timestamp).toLocaleString()}</span>
                <button type="button" className="recording-delete-btn" title="Delete snapshot" onClick={(event) => { event.stopPropagation(); void deleteSnapshot(snapshot.id); }}>
                  <Trash2 size={12} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="no-recordings-box">
          <ImageIcon size={24} className="no-rec-icon" />
          <p className="no-rec-text">No detection snapshots stored.</p>
          <span className="no-rec-hint">A photo will appear here when a person is detected.</span>
        </div>
      )}

      {selected && (
        <div className="video-modal-backdrop" onClick={() => setSelected(null)}>
          <div className="video-modal-content" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <header className="video-modal-header">
              <div className="video-modal-title">
                <ImageIcon size={16} />
                <div><h3>Detection — {deviceName}</h3><span className="video-modal-meta">{new Date(selected.timestamp).toLocaleString()}</span></div>
              </div>
              <button type="button" className="btn-modal-close" aria-label="Close snapshot" onClick={() => setSelected(null)}><X size={18} /></button>
            </header>
            <div className="video-modal-player-wrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="modal-html5-video" src={selected.snapshotUrl} alt={`Person detected at ${new Date(selected.timestamp).toLocaleString()}`} />
            </div>
            <footer className="video-modal-footer">
              <div className="modal-actions-right">
                <a className="btn-secondary btn-download-clip" href={selected.snapshotUrl} download={selected.filename}><Download size={13} /> Download photo</a>
                <button type="button" className="btn-secondary btn-delete-clip" onClick={() => void deleteSnapshot(selected.id)}><Trash2 size={13} /> Delete photo</button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
};

export default RecordedVideos;
