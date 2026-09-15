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
  Play,
  RotateCw,
  Info,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';

interface CameraFeedProps {
  initialStreamUrl?: string;
}

export const CameraFeed: React.FC<CameraFeedProps> = ({ initialStreamUrl }) => {
  const [streamUrl, setStreamUrl] = useState<string>(initialStreamUrl || '');
  const [relayUrl, setRelayUrl] = useState<string>('');
  const [streamSource, setStreamSource] = useState<'LOCAL' | 'RELAY' | 'MANUAL'>('LOCAL');
  const [inputUrl, setInputUrl] = useState<string>('');
  const [showConfig, setShowConfig] = useState<boolean>(false);
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [status, setStatus] = useState<'ONLINE' | 'OFFLINE' | 'CONNECTING' | 'RECONNECTING'>('CONNECTING');
  const [lastUpdated, setLastUpdated] = useState<string>('Never');
  const [retryCount, setRetryCount] = useState<number>(0);
  const [streamKey, setStreamKey] = useState<number>(Date.now());
  const containerRef = useRef<HTMLDivElement>(null);

  // Load saved stream URL from localStorage on mount
  useEffect(() => {
    const savedRelay = localStorage.getItem('securehome_camera_relay_url');
    const savedLocal = localStorage.getItem('securehome_camera_stream_url');
    if (savedRelay && !initialStreamUrl) {
      setRelayUrl(savedRelay);
      setStreamUrl(savedRelay);
      setInputUrl(savedRelay);
      setStreamSource('RELAY');
      setStatus('ONLINE');
    } else if (savedLocal && !initialStreamUrl) {
      setStreamUrl(savedLocal);
      setInputUrl(savedLocal);
      setStreamSource('LOCAL');
      setStatus('ONLINE');
    }
  }, [initialStreamUrl]);

  // MQTT auto-discovery, relay URL & status telemetry
  useEffect(() => {
    const client = getMqttClient();

    const onConnect = () => {
      client.subscribe('security/camera/discovery');
      client.subscribe('security/camera/status');
      client.subscribe('security/camera/relay_url');
    };

    const onMessage = (topic: string, message: Buffer) => {
      const msgStr = message.toString();

      if (topic === 'security/camera/relay_url') {
        try {
          const data = JSON.parse(msgStr);
          if (data.url) {
            setRelayUrl(data.url);
            setStreamUrl(data.url);
            setInputUrl(data.url);
            setStreamSource('RELAY');
            localStorage.setItem('securehome_camera_relay_url', data.url);
            setStatus('ONLINE');
            setRetryCount(0);
            setStreamKey(Date.now());
            setLastUpdated(new Date().toLocaleTimeString());
          }
        } catch {
          // ignore malformed payload
        }
      }

      if (topic === 'security/camera/discovery') {
        try {
          const data = JSON.parse(msgStr);
          if (data.ip) {
            const port = data.port || 81;
            const path = data.stream_path || '/stream';
            const url = `http://${data.ip}:${port}${path}`;
            // Only use local URL if no relay is available
            if (!relayUrl) {
              setStreamUrl(url);
              setInputUrl(url);
              setStreamSource('LOCAL');
              setStatus('ONLINE');
              setRetryCount(0);
              setStreamKey(Date.now());
              setLastUpdated(new Date().toLocaleTimeString());
            }
            localStorage.setItem('securehome_camera_stream_url', url);
          }
        } catch {
          const url = msgStr.startsWith('http') ? msgStr : `http://${msgStr}/stream`;
          if (!relayUrl) {
            setStreamUrl(url);
            setInputUrl(url);
            setStreamSource('LOCAL');
            setStatus('ONLINE');
            setRetryCount(0);
            setLastUpdated(new Date().toLocaleTimeString());
          }
          localStorage.setItem('securehome_camera_stream_url', url);
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
  }, [relayUrl]);

  // Format and save manual URL/IP input
  const handleApplyManualUrl = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputUrl.trim()) return;

    let target = inputUrl.trim();
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      if (target.includes(':')) {
        target = `http://${target}/stream`;
      } else {
        target = `http://${target}:81/stream`;
      }
    }

    // Manual override clears the relay preference
    setRelayUrl('');
    localStorage.removeItem('securehome_camera_relay_url');
    setStreamUrl(target);
    setInputUrl(target);
    setStreamSource('MANUAL');
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
    <section className="card camera-card" aria-label="Live Camera Feed">
      <header className="card-header">
        <div className="card-title">
          <div className="card-title-icon">
            <Camera size={16} />
          </div>
          <div>
            <h3>Video Surveillance</h3>
            <span className="card-subtitle">Node 02 &bull; Front Entrance</span>
          </div>
        </div>

        <div className="header-controls">
          <div className={`status-badge status-${status.toLowerCase()}`}>
            {status === 'ONLINE' ? (
              <>
                <span className="status-dot dot-online" />
                <span>ONLINE</span>
              </>
            ) : status === 'RECONNECTING' ? (
              <>
                <RotateCw size={12} className="spin-icon" />
                <span>RETRYING ({retryCount}/3)</span>
              </>
            ) : (
              <>
                <span className="status-dot dot-offline" />
                <span>{status}</span>
              </>
            )}
          </div>

          <button
            type="button"
            className={`btn-icon ${showConfig ? 'active' : ''}`}
            onClick={() => setShowConfig(!showConfig)}
            title="Configure Camera IP / Stream URL"
            aria-label="Configure Camera IP"
          >
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* Manual IP / URL Input Drawer */}
      {showConfig && (
        <form onSubmit={handleApplyManualUrl} className="camera-config-bar">
          <div className="config-input-group">
            <label htmlFor="cam-ip-input">Manual Stream IP or Endpoint:</label>
            <input
              id="cam-ip-input"
              type="text"
              placeholder="e.g. 192.168.1.150 or http://192.168.1.150:81/stream"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn-set-stream">
            <Play size={13} /> Set Feed
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
              alt="ESP32-CAM MJPEG Video Stream"
              className="video-feed"
              onLoad={() => {
                setStatus('ONLINE');
                setRetryCount(0);
              }}
              onError={handleImageError}
            />
            <div className="stream-overlay-badge">
              <span className="live-dot" />
              <span>LIVE</span>
            </div>
          </>
        ) : (
          <div className="video-placeholder">
            <div className="placeholder-icon-wrap">
              <Camera size={32} />
            </div>
            <h4>
              {status === 'OFFLINE'
                ? 'Camera Disconnected'
                : 'Waiting for Camera Telemetry'}
            </h4>
            <p className="placeholder-desc">
              {status === 'OFFLINE'
                ? 'The MJPEG stream timed out. Ensure the ESP32-CAM is powered and connected.'
                : 'Listening for discovery broadcast or manual IP assignment.'}
            </p>

            <div className="placeholder-actions">
              {streamUrl && (
                <button type="button" className="btn-secondary" onClick={triggerRefresh}>
                  <RefreshCw size={13} /> Reconnect
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowConfig(true)}
              >
                Set IP Manually
              </button>
            </div>

            <div className="diagnostics-toggle-container">
              <button
                type="button"
                className="btn-text-toggle"
                onClick={() => setShowDiagnostics(!showDiagnostics)}
              >
                <Info size={13} />
                <span>Connection Diagnostics</span>
                {showDiagnostics ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>

              {showDiagnostics && (
                <ul className="diagnostics-list">
                  <li>Verify ESP32-CAM is powered by dedicated 5V/2A supply</li>
                  <li>Confirm 100µF+ decoupling capacitor across 5V and GND</li>
                  <li>Check Serial Monitor (115200 baud) for IP assigned by router</li>
                  <li>Verify Command Center host and ESP32 share the same subnet</li>
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer Details & Action Controls */}
      <footer className="card-footer">
        <div className="endpoint-details">
          <div className="endpoint-row">
            <span className="meta-label">SOURCE</span>
            {streamUrl ? (
              <code className="endpoint-code">{streamUrl}</code>
            ) : (
              <span className="endpoint-empty">Unconfigured</span>
            )}
          </div>
          <div className="endpoint-row">
            {streamUrl && (
              <span
                className={`source-badge source-badge--${streamSource.toLowerCase()}`}
                title={
                  streamSource === 'RELAY'
                    ? 'Stream served via ngrok relay — works from any network'
                    : streamSource === 'LOCAL'
                    ? 'Stream served directly from local IP — home network only'
                    : 'Manually configured stream URL'
                }
              >
                {streamSource === 'RELAY' ? '🌐 RELAY' : streamSource === 'LOCAL' ? '🏠 LOCAL' : '✏️ MANUAL'}
              </span>
            )}
            {lastUpdated !== 'Never' && (
              <span className="updated-text">Updated {lastUpdated}</span>
            )}
          </div>
        </div>

        <div className="feed-actions">
          {directBaseUrl && (
            <a
              href={directBaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-action-sm"
              title="Open camera web preview directly in a new tab"
            >
              <ExternalLink size={13} />
              <span>Preview</span>
            </a>
          )}

          <button
            type="button"
            className="btn-action-sm"
            onClick={triggerRefresh}
            title="Refresh stream connection"
            disabled={!streamUrl}
          >
            <RefreshCw size={13} />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            className="btn-action-sm btn-action-icon-only"
            onClick={toggleFullscreen}
            title="Toggle fullscreen mode"
            aria-label="Toggle fullscreen"
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </footer>
    </section>
  );
};

export default CameraFeed;
