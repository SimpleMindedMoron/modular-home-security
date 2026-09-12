'use client';

import React, { useEffect, useState } from 'react';
import { Camera, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';

interface CameraFeedProps {
  initialStreamUrl?: string;
}

export const CameraFeed: React.FC<CameraFeedProps> = ({ initialStreamUrl }) => {
  const [streamUrl, setStreamUrl] = useState<string>(initialStreamUrl || '');
  const [status, setStatus] = useState<'ONLINE' | 'OFFLINE' | 'CONNECTING'>('CONNECTING');
  const [lastUpdated, setLastUpdated] = useState<string>('Never');

  useEffect(() => {
    const client = getMqttClient();

    const onConnect = () => {
      client.subscribe('security/camera/discovery');
      client.subscribe('security/camera/status');
    };

    const onMessage = (topic: string, message: Buffer) => {
      const msgStr = message.toString();

      if (topic === 'security/camera/discovery') {
        try {
          const data = JSON.parse(msgStr);
          if (data.ip) {
            const port = data.port || 81;
            const path = data.stream_path || '/stream';
            setStreamUrl(`http://${data.ip}:${port}${path}`);
            setStatus('ONLINE');
            setLastUpdated(new Date().toLocaleTimeString());
          }
        } catch {
          // Plain URL or string IP support
          setStreamUrl(msgStr.startsWith('http') ? msgStr : `http://${msgStr}/stream`);
          setStatus('ONLINE');
          setLastUpdated(new Date().toLocaleTimeString());
        }
      }

      if (topic === 'security/camera/status') {
        setStatus(msgStr.toUpperCase() === 'ONLINE' ? 'ONLINE' : 'OFFLINE');
      }
    };

    if (client.connected) {
      onConnect();
    }
    client.on('connect', onConnect);
    client.on('message', onMessage);

    return () => {
      client.off('message', onMessage);
    };
  }, []);

  return (
    <div className="card camera-card">
      <div className="card-header">
        <div className="card-title">
          <Camera className="icon" size={20} />
          <h3>Live Camera Feed</h3>
        </div>
        <div className={`status-badge status-${status.toLowerCase()}`}>
          {status === 'ONLINE' ? <Wifi size={14} /> : <WifiOff size={14} />}
          <span>{status}</span>
        </div>
      </div>

      <div className="video-container">
        {status === 'ONLINE' && streamUrl ? (
          <img
            src={streamUrl}
            alt="ESP32-CAM MJPEG Stream"
            className="video-feed"
            onError={() => setStatus('OFFLINE')}
          />
        ) : (
          <div className="video-placeholder">
            <Camera size={48} className="placeholder-icon" />
            <p>
              {status === 'OFFLINE'
                ? 'Camera node is currently offline'
                : 'Waiting for camera discovery broadcast...'}
            </p>
            <span className="placeholder-hint">
              Topic: <code>security/camera/discovery</code>
            </span>
          </div>
        )}
      </div>

      <div className="card-footer">
        <span className="endpoint-text">
          Source: {streamUrl ? <code>{streamUrl}</code> : <em>None detected</em>}
        </span>
        <button
          className="btn-refresh"
          onClick={() => {
            if (streamUrl) {
              const url = new URL(streamUrl);
              url.searchParams.set('_t', Date.now().toString());
              setStreamUrl(url.toString());
            }
          }}
          title="Refresh stream"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
    </div>
  );
};

export default CameraFeed;
