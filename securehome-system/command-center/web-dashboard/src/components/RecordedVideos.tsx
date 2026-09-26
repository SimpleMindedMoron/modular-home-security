'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Video,
  Play,
  Trash2,
  Clock,
  ShieldAlert,
  Download,
  X,
  Sparkles,
  AlertCircle,
  Eye,
  Film,
  Maximize2,
  RefreshCw,
  Flame,
} from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';

// =============================================================================
// 🎯 AUTO-DELETE DURATION CONFIGURATION & PRESETS (FRONTEND DASHBOARD)
// =============================================================================
export interface RetentionOption {
  label: string;
  valueSeconds: number;
}

export const RETENTION_OPTIONS: RetentionOption[] = [
  { label: '1 min (Testing)', valueSeconds: 60 },
  { label: '30 days', valueSeconds: 30 * 24 * 60 * 60 }, // 2,592,000s
  { label: '45 days', valueSeconds: 45 * 24 * 60 * 60 }, // 3,888,000s
  { label: '60 days', valueSeconds: 60 * 24 * 60 * 60 }, // 5,184,000s
];

export const DEFAULT_RETENTION_SECONDS = 60; // Default: 1 minute

export const formatRemainingTime = (seconds: number): string => {
  if (seconds <= 0) return '0s';
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) {
    return remSec > 0 ? `${minutes}m ${remSec}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) {
    return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
};

export const getRetentionLabel = (seconds: number): string => {
  const match = RETENTION_OPTIONS.find((opt) => opt.valueSeconds === seconds);
  if (match) return match.label;
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} days`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} mins`;
  return `${seconds}s`;
};

export interface RecordedVideoItem {
  id: string;
  deviceId: string;
  cameraName: string;
  filename: string;
  videoUrl: string;
  thumbnailUrl?: string;
  timestamp: string;
  createdAt: number; // epoch ms
  confidence: number;
  duration: number; // seconds
}

interface RecordedVideosProps {
  deviceId?: string;
  deviceName?: string;
  relayUrl?: string;
  topicPrefix?: string;
}

export const RecordedVideos: React.FC<RecordedVideosProps> = ({
  deviceId = 'ESP32_CAM_01',
  deviceName = 'Front Entrance Camera',
  relayUrl = '',
  topicPrefix,
}) => {
  const [recordings, setRecordings] = useState<RecordedVideoItem[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<RecordedVideoItem | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [justDeletedId, setJustDeletedId] = useState<string | null>(null);

  // User-selected retention duration (persisted in localStorage)
  const [retentionSeconds, setRetentionSeconds] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('securehome_retention_duration');
      if (saved && !isNaN(Number(saved))) {
        return Number(saved);
      }
    }
    return DEFAULT_RETENTION_SECONDS;
  });

  // Handle dropdown selection change
  const handleRetentionChange = (newDurationSeconds: number) => {
    setRetentionSeconds(newDurationSeconds);
    if (typeof window !== 'undefined') {
      localStorage.setItem('securehome_retention_duration', String(newDurationSeconds));
    }

    // Broadcast retention setting change via MQTT to backend
    try {
      const client = getMqttClient();
      if (client && client.connected) {
        const payload = JSON.stringify({
          retention_seconds: newDurationSeconds,
          device_uid: deviceId,
          timestamp: new Date().toISOString(),
        });
        client.publish('security/camera/settings/retention', payload, { qos: 1, retain: true });
        if (topicPrefix) {
          client.publish(`${topicPrefix}/settings/retention`, payload, { qos: 1, retain: true });
        }
      }
    } catch (err) {
      console.error('Failed to publish retention duration update:', err);
    }
  };

  // 1. Ticker for live auto-deletion countdown (runs every 1 second)
  useEffect(() => {
    const timer = setInterval(() => {
      const currentNow = Date.now();
      setNow(currentNow);

      // =======================================================================
      // 👉 AUTO-DELETION FRONTEND PURGE LOGIC
      // Automatically removes any recording whose age has exceeded
      // the currently selected retentionSeconds (e.g. 1 min, 30d, 45d, 60d).
      // =======================================================================
      setRecordings((prev) => {
        const remaining = prev.filter((item) => {
          const ageSeconds = (currentNow - item.createdAt) / 1000;
          return ageSeconds < retentionSeconds;
        });

        // If an item was purged and it's currently open in modal, close modal
        if (selectedVideo) {
          const stillExists = remaining.some((r) => r.id === selectedVideo.id);
          if (!stillExists) {
            setSelectedVideo(null);
          }
        }

        return remaining;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [selectedVideo, retentionSeconds]);

  // 2. Fetch initial recordings from backend / AI processor API
  const fetchRecordings = useCallback(async () => {
    try {
      const targetRelay = relayUrl || (typeof window !== 'undefined' ? localStorage.getItem('securehome_camera_relay_url') : '');
      const url = targetRelay
        ? `/api/recordings?device_uid=${encodeURIComponent(deviceId)}&relay_url=${encodeURIComponent(targetRelay)}&retention_seconds=${retentionSeconds}`
        : `/api/recordings?device_uid=${encodeURIComponent(deviceId)}&retention_seconds=${retentionSeconds}`;

      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      if (Array.isArray(data.recordings)) {
        const mapped: RecordedVideoItem[] = data.recordings.map((r: any) => ({
          id: r.id,
          deviceId: r.device_uid || deviceId,
          cameraName: deviceName,
          filename: r.filename || `${r.id}.mp4`,
          videoUrl: r.video_url,
          thumbnailUrl: r.thumbnail_url,
          timestamp: r.timestamp || new Date().toLocaleTimeString(),
          createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
          confidence: r.confidence || 0.95,
          duration: r.duration || 10,
        }));

        setRecordings((prev) => {
          // Merge deduplicated
          const map = new Map<string, RecordedVideoItem>();
          [...mapped, ...prev].forEach((item) => {
            const ageSec = (Date.now() - item.createdAt) / 1000;
            if (ageSec < retentionSeconds) {
              map.set(item.id, item);
            }
          });
          return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
        });
      }
    } catch (err) {
      // Backend api optional in offline mode
    }
  }, [deviceId, deviceName, relayUrl, retentionSeconds]);

  useEffect(() => {
    fetchRecordings();
    const interval = setInterval(fetchRecordings, 10000);
    return () => clearInterval(interval);
  }, [fetchRecordings]);

  // 3. MQTT Person Alert Listener -> Automatically add new video recording
  useEffect(() => {
    const client = getMqttClient();

    const onConnect = () => {
      client.subscribe('security/alerts/person');
      if (topicPrefix) {
        client.subscribe(`${topicPrefix}/alerts/person`);
      }
    };

    const onMessage = (topic: string, message: Buffer) => {
      if (topic === 'security/alerts/person' || topic.endsWith('/alerts/person')) {
        try {
          const payload = JSON.parse(message.toString());
          const targetCam = payload.camera || deviceId;

          // If this alert belongs to current camera or wildcard
          if (!payload.camera || payload.camera === deviceId || payload.camera === 'cam_front_door' || payload.camera === 'ESP32_CAM_01') {
            const recId = payload.recording_id || `rec_${Date.now()}_${Math.floor(Math.random()*1000)}`;
            const timeStr = payload.timestamp
              ? new Date(payload.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              : new Date().toLocaleTimeString();

            const baseRelay = relayUrl || (typeof window !== 'undefined' ? localStorage.getItem('securehome_camera_relay_url') : '') || '';
            const videoUrl = payload.video_url
              ? (payload.video_url.startsWith('http') ? payload.video_url : `${baseRelay}${payload.video_url}`)
              : '';
            const thumbnailUrl = payload.thumbnail_url
              ? (payload.thumbnail_url.startsWith('http') ? payload.thumbnail_url : `${baseRelay}${payload.thumbnail_url}`)
              : '';

            const newClip: RecordedVideoItem = {
              id: recId,
              deviceId: targetCam,
              cameraName: deviceName,
              filename: payload.filename || `${recId}.mp4`,
              videoUrl: videoUrl,
              thumbnailUrl: thumbnailUrl,
              timestamp: timeStr,
              createdAt: Date.now(),
              confidence: payload.confidence || 0.94,
              duration: payload.duration || 10,
            };

            setRecordings((prev) => {
              // Avoid duplicates
              if (prev.some((r) => r.id === recId)) return prev;
              return [newClip, ...prev];
            });
          }
        } catch (e) {
          console.error('[MQTT] Error parsing person alert for recording:', e);
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
  }, [deviceId, deviceName, relayUrl, topicPrefix]);

  // 4. Manual delete handler
  const handleDelete = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setJustDeletedId(id);
    setTimeout(() => setJustDeletedId(null), 1000);

    setRecordings((prev) => prev.filter((r) => r.id !== id));
    if (selectedVideo?.id === id) {
      setSelectedVideo(null);
    }

    try {
      await fetch(`/api/recordings?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      // ignore
    }
  };

  // 5. Simulated Person Detection & Recording Trigger (For instant testing)
  const handleSimulateDetection = () => {
    setIsSimulating(true);
    const mockId = `mock_rec_${Date.now()}`;
    const mockTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const newClip: RecordedVideoItem = {
      id: mockId,
      deviceId: deviceId,
      cameraName: deviceName,
      filename: `detection_${Date.now()}.mp4`,
      videoUrl: '', // Will use interactive demo canvas player fallback
      timestamp: mockTime,
      createdAt: Date.now(),
      confidence: 0.96,
      duration: 10,
    };

    setTimeout(() => {
      setRecordings((prev) => [newClip, ...prev]);
      setIsSimulating(false);
    }, 400);
  };

  return (
    <section className="recorded-videos-section" aria-label="Detection Video Recordings">
      {/* Section Header */}
      <div className="recorded-videos-header">
        <div className="recorded-videos-title">
          <div className="record-pulse-badge">
            <Film size={14} />
          </div>
          <div>
            <h4>Detection Recordings</h4>
            <span className="recorded-videos-subtitle">
              Auto-saved clips on person detection &bull;{' '}
              <strong className="retention-highlight">
                Retention: {getRetentionLabel(retentionSeconds)}
              </strong>
            </span>
          </div>
        </div>

        <div className="recorded-videos-controls">
          {/* 🎯 Retention Duration Dropdown Selector */}
          <div className="retention-dropdown-wrapper" title="Change how long recorded clips are kept before auto-deletion">
            <label htmlFor={`retention-select-${deviceId}`} className="retention-select-label">
              <Clock size={12} />
              <span>Auto-Delete:</span>
            </label>
            <select
              id={`retention-select-${deviceId}`}
              value={retentionSeconds}
              onChange={(e) => handleRetentionChange(Number(e.target.value))}
              className="retention-select-input"
            >
              {RETENTION_OPTIONS.map((opt) => (
                <option key={opt.valueSeconds} value={opt.valueSeconds}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="btn-simulate-detect"
            onClick={handleSimulateDetection}
            disabled={isSimulating}
            title="Simulate person detection and test auto-delete countdown"
          >
            <Sparkles size={12} className={isSimulating ? 'spin-icon' : ''} />
            <span>{isSimulating ? 'Capturing...' : 'Test Detection Clip'}</span>
          </button>

          <button
            type="button"
            className="btn-icon btn-refresh-recordings"
            onClick={fetchRecordings}
            title="Refresh recordings list"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* Recordings Grid / List */}
      {recordings.length > 0 ? (
        <div className="recordings-grid">
          {recordings.map((clip) => {
            const ageSeconds = Math.floor((now - clip.createdAt) / 1000);
            const remainingSeconds = Math.max(0, retentionSeconds - ageSeconds);
            const progressPercent = Math.min(100, Math.max(0, (remainingSeconds / retentionSeconds) * 100));

            // Color coding as retention expiration nears
            const isUrgent = remainingSeconds <= Math.min(15, retentionSeconds * 0.25);
            const isWarning = remainingSeconds <= Math.min(30, retentionSeconds * 0.5) && !isUrgent;

            return (
              <div
                key={clip.id}
                className={`recording-card ${isUrgent ? 'recording-card--urgent' : ''}`}
                onClick={() => setSelectedVideo(clip)}
              >
                {/* Thumbnail Preview Area */}
                <div className="recording-thumb-wrapper">
                  {clip.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={clip.thumbnailUrl}
                      alt={`Detection preview at ${clip.timestamp}`}
                      className="recording-thumb-img"
                    />
                  ) : (
                    <div className="recording-thumb-placeholder">
                      <ShieldAlert size={22} className="thumb-ai-icon" />
                      <span className="thumb-ai-label">PERSON DETECTED</span>
                    </div>
                  )}

                  {/* Play Overlay Button */}
                  <div className="recording-play-overlay">
                    <div className="play-circle-btn">
                      <Play size={14} fill="currentColor" />
                    </div>
                  </div>

                  {/* Confidence Badge */}
                  <div className="recording-badge-confidence">
                    <span>{Math.round(clip.confidence * 100)}% Match</span>
                  </div>

                  {/* Duration Badge */}
                  <div className="recording-badge-duration">
                    <span>00:{clip.duration.toString().padStart(2, '0')}</span>
                  </div>
                </div>

                {/* Card Content & Expiration Bar */}
                <div className="recording-card-body">
                  <div className="recording-meta-row">
                    <span className="recording-timestamp">
                      <Clock size={11} />
                      {clip.timestamp}
                    </span>
                    <button
                      type="button"
                      className="recording-delete-btn"
                      onClick={(e) => handleDelete(clip.id, e)}
                      title="Delete recording now"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>

                  {/* ⏳ Auto-Deletion Real-Time Countdown */}
                  <div className="recording-retention-timer">
                    <div className="retention-info-row">
                      <span className={`retention-countdown-text ${isUrgent ? 'text-urgent' : isWarning ? 'text-warning' : ''}`}>
                        <Flame size={11} /> Auto-deletes in <strong>{formatRemainingTime(remainingSeconds)}</strong>
                      </span>
                      <span className="retention-fraction">
                        {formatRemainingTime(remainingSeconds)} / {getRetentionLabel(retentionSeconds)}
                      </span>
                    </div>
                    {/* Live Progress Bar */}
                    <div className="retention-progress-track">
                      <div
                        className={`retention-progress-fill ${isUrgent ? 'fill-urgent' : isWarning ? 'fill-warning' : ''}`}
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="no-recordings-box">
          <Film size={24} className="no-rec-icon" />
          <p className="no-rec-text">No recorded video clips currently stored.</p>
          <span className="no-rec-hint">
            When a person is detected by AI, a video clip will automatically appear here and auto-delete after {getRetentionLabel(retentionSeconds)}.
          </span>
        </div>
      )}

      {/* =====================================================================
          🎬 Full-Featured Video Player Modal
          ===================================================================== */}
      {selectedVideo && (
        <div className="video-modal-backdrop" onClick={() => setSelectedVideo(null)}>
          <div
            className="video-modal-content"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {/* Modal Header */}
            <div className="video-modal-header">
              <div className="video-modal-title">
                <div className="video-modal-icon">
                  <Video size={16} />
                </div>
                <div>
                  <h3>Detection Recording: {selectedVideo.cameraName}</h3>
                  <span className="video-modal-meta">
                    Timestamp: {selectedVideo.timestamp} &bull; Confidence: {Math.round(selectedVideo.confidence * 100)}%
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="btn-modal-close"
                onClick={() => setSelectedVideo(null)}
                aria-label="Close video player"
              >
                <X size={18} />
              </button>
            </div>

            {/* Video Player Display */}
            <div className="video-modal-player-wrap">
              {selectedVideo.videoUrl ? (
                <video
                  src={selectedVideo.videoUrl}
                  controls
                  autoPlay
                  playsInline
                  className="modal-html5-video"
                  poster={selectedVideo.thumbnailUrl}
                >
                  Your browser does not support HTML5 video playback.
                </video>
              ) : (
                <div className="simulated-video-canvas">
                  <div className="canvas-scanner-effect" />
                  <div className="canvas-person-box">
                    <div className="box-corner tl" />
                    <div className="box-corner tr" />
                    <div className="box-corner bl" />
                    <div className="box-corner br" />
                    <div className="box-tag">HUMAN_TARGET {Math.round(selectedVideo.confidence * 100)}%</div>
                  </div>
                  <div className="canvas-hud-overlay">
                    <span>RECORDING: {selectedVideo.filename}</span>
                    <span>FPS: 15 &bull; 1080P PROCESSED</span>
                    <span className="hud-live-tag">● AI CAPTURE</span>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer with Live Retention Timer & Actions */}
            <div className="video-modal-footer">
              <div className="modal-retention-pill">
                <Clock size={13} />
                <span>
                  Auto-deletes in{' '}
                  <strong>
                    {formatRemainingTime(Math.max(0, retentionSeconds - Math.floor((now - selectedVideo.createdAt) / 1000)))}
                  </strong>{' '}
                  ({getRetentionLabel(retentionSeconds)} retention rule)
                </span>
              </div>

              <div className="modal-actions-right">
                {selectedVideo.videoUrl && (
                  <a
                    href={selectedVideo.videoUrl}
                    download={selectedVideo.filename}
                    className="btn-secondary btn-download-clip"
                  >
                    <Download size={13} />
                    <span>Download Clip</span>
                  </a>
                )}
                <button
                  type="button"
                  className="btn-secondary btn-delete-clip"
                  onClick={() => handleDelete(selectedVideo.id)}
                >
                  <Trash2 size={13} />
                  <span>Delete Now</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default RecordedVideos;
