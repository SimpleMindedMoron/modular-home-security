'use client';

import React, { useEffect, useState, useRef } from 'react';
import {
  Camera,
  RefreshCw,
  Wifi,
  WifiOff,
  ExternalLink,
  Settings,
  Maximize2,
  AlertCircle,
  Play,
  RotateCw,
} from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';

interface CameraFeedProps {
  initialStreamUrl?: string;
}

export const CameraFeed: React.FC<CameraFeedProps> = ({ initialStreamUrl }) => {
  const [streamUrl, setStreamUrl] = useState<string>(initialStreamUrl || '');
  const [inputUrl, setInputUrl] = useState<string>('');
  const [showConfig, setShowConfig] = useState<boolean>(false);
  const [status, setStatus] = useState<'ONLINE' | 'OFFLINE' | 'CONNECTING' | 'RECONNECTING'>('CONNECTING');
  const [lastUpdated, setLastUpdated] = useState<string>('Never');
  const [retryCount, setRetryCount] = useState<number>(0);
  const [streamKey, setStreamKey] = useState<number>(Date.now());
  const containerRef = useRef<HTMLDivElement>(null);

  // Load saved stream URL from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('securehome_camera_stream_url');
    if (saved && !initialStreamUrl) {
      setStreamUrl(saved);
      setInputUrl(saved);
      setStatus('ONLINE');
    }
  }, [initialStreamUrl]);

  // MQTT auto-discovery & status telemetry
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
            const url = `http://${data.ip}:${port}${path}`;
            setStreamUrl(url);
            setInputUrl(url);
            localStorage.setItem('securehome_camera_stream_url', url);
            setStatus('ONLINE');
            setRetryCount(0);
            setLastUpdated(new Date().toLocaleTimeString());
          }
        } catch {
          const url = msgStr.startsWith('http') ? msgStr : `http://${msgStr}/stream`;
          setStreamUrl(url);
          setInputUrl(url);
          localStorage.setItem('securehome_camera_stream_url', url);
          setStatus('ONLINE');
          setRetryCount(0);
          setLastUpdated(new Date().toLocaleTimeString());
        }
      }

      if (topic === 'security/camera/status') {
        const isOnline = msgStr.toUpperCase() === 'ONLINE';
        if (isOnline) {
          setStatus('ONLINE');
          setRetryCount(0);
        } else {
          setStatus('OFFLINE');
        }
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

  // Format and save manual URL/IP input
  const handleApplyManualUrl = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputUrl.trim()) return;

    let target = inputUrl.trim();
    // If user just typed an IP address like 192.168.1.50 or 192.168.1.50:81
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      if (target.includes(':')) {
        target = `http://${target}/stream`;
      } else {
        target = `http://${target}:81/stream`;
      }
    }

    setStreamUrl(target);
    setInputUrl(target);
    localStorage.setItem('securehome_camera_stream_url', target);
    setStatus('ONLINE');
    setRetryCount(0);
    setStreamKey(Date.now());
    setLastUpdated(new Date().toLocaleTimeString());
    setShowConfig(false);
  };

  // Reconnection and cache-busting refresh
  const triggerRefresh = () => {
    if (!streamUrl) return;
    setStatus('RECONNECTING');
    setStreamKey(Date.now());
    setTimeout(() => {
      setStatus('ONLINE');
    }, 500);
  };

  // Handle stream image error
  const handleImageError = () => {
    if (retryCount < 3) {
      setStatus('RECONNECTING');
      const nextRetry = retryCount + 1;
      setRetryCount(nextRetry);
      setTimeout(() => {
        setStreamKey(Date.now());
      }, 2000);
    } else {
      setStatus('OFFLINE');
    }
  };

  // Toggle fullscreen
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.current.requestFullscreen().catch((err) => {
        console.error('Fullscreen request failed:', err);
      });
    }
  };

  // Extract base URL for opening preview page
  const directBaseUrl = streamUrl ? streamUrl.replace(/\/stream.*$/, '/') : '';

  return (
    <div className="card camera-card">
      <div className="card-header">
        <div className="card-title">
          <Camera className="icon" size={20} />
          <h3>Live Camera Feed</h3>
        </div>

        <div className="header-controls">
          <div className={`status-badge status-${status.toLowerCase()}`}>
            {status === 'ONLINE' ? (
              <>
                <Wifi size={14} />
                <span>ONLINE</span>
              </>
            ) : status === 'RECONNECTING' ? (
              <>
                <RotateCw size={14} className="spin-icon" />
                <span>RETRYING ({retryCount}/3)</span>
              </>
            ) : (
              <>
                <WifiOff size={14} />
                <span>{status}</span>
              </>
            )}
          </div>

          <button
            className={`btn-icon ${showConfig ? 'active' : ''}`}
            onClick={() => setShowConfig(!showConfig)}
            title="Configure Camera IP / Stream URL"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Manual IP / URL Input Drawer */}
      {showConfig && (
        <form onSubmit={handleApplyManualUrl} className="camera-config-bar">
          <div className="config-input-group">
            <label htmlFor="cam-ip-input">Camera IP or Stream URL:</label>
            <input
              id="cam-ip-input"
              type="text"
              placeholder="e.g. 192.168.1.150 or http://192.168.1.150:81/stream"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-set-stream">
            <Play size={14} /> Set Feed
          </button>
        </form>
      )}

      {/* Video Stream Container */}
      <div className="video-container" ref={containerRef}>
        {(status === 'ONLINE' || status === 'RECONNECTING') && streamUrl ? (
          <>
            <img
              key={streamKey}
              src={`${streamUrl}${streamUrl.includes('?') ? '&' : '?'}_t=${streamKey}`}
              alt="ESP32-CAM MJPEG Stream"
              className="video-feed"
              onLoad={() => {
                setStatus('ONLINE');
                setRetryCount(0);
              }}
              onError={handleImageError}
            />
            <div className="stream-overlay-badge">
              <span className="live-dot" /> LIVE
            </div>
          </>
        ) : (
          <div className="video-placeholder">
            <Camera size={48} className="placeholder-icon" />
            <p>
              {status === 'OFFLINE'
                ? 'Camera stream disconnected'
                : 'Waiting for camera discovery or manual IP...'}
            </p>

            <div className="placeholder-actions">
              {streamUrl && (
                <button className="btn-retry" onClick={triggerRefresh}>
                  <RefreshCw size={14} /> Reconnect Feed
                </button>
              )}
              <button
                className="btn-set-ip-hint"
                onClick={() => setShowConfig(true)}
              >
                Enter Camera IP Manually
              </button>
            </div>

            <div className="placeholder-diagnostics">
              <span>💡 Troubleshooting:</span>
              <ul>
                <li>Ensure ESP32-CAM is powered with a 5V/2A adapter</li>
                <li>Check Arduino IDE Serial Monitor (115200 baud) for assigned IP</li>
                <li>Verify your PC and ESP32-CAM are on the same Wi-Fi network</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* Footer Details & Action Controls */}
      <div className="card-footer">
        <div className="endpoint-details">
          <span className="endpoint-text">
            Source:{' '}
            {streamUrl ? (
              <code>{streamUrl}</code>
            ) : (
              <em>Not configured yet (click ⚙️ above or power on ESP32-CAM)</em>
            )}
          </span>
          {lastUpdated !== 'Never' && (
            <span className="updated-text">Updated: {lastUpdated}</span>
          )}
        </div>

        <div className="feed-actions">
          {directBaseUrl && (
            <a
              href={directBaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-link"
              title="Open camera web preview directly in a new tab"
            >
              <ExternalLink size={14} /> Test in Tab
            </a>
          )}

          <button
            className="btn-refresh"
            onClick={triggerRefresh}
            title="Refresh stream connection"
            disabled={!streamUrl}
          >
            <RefreshCw size={14} /> Refresh
          </button>

          <button
            className="btn-icon-control"
            onClick={toggleFullscreen}
            title="Toggle fullscreen mode"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default CameraFeed;

