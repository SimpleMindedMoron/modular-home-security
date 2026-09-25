'use client';

import React, { useEffect, useState, useCallback } from 'react';
import {
  Lock,
  Unlock,
  KeyRound,
  RotateCw,
  WifiOff,
  Trash2,
  CreditCard,
  Plus,
  ScanLine,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Pencil,
} from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';

interface DoorLockProps {
  deviceName?: string;
  deviceId?: string;
  topicPrefix?: string;
  onDelete?: () => void;
}

interface RegisteredCard {
  uid: string;
  label: string;
}

type EnrollStep = 'idle' | 'waiting_scan' | 'confirm' | 'saving' | 'success' | 'error';

export const DoorLock: React.FC<DoorLockProps> = ({
  deviceName,
  deviceId,
  topicPrefix,
  onDelete,
}) => {
  const [lockStatus, setLockStatus] = useState<'LOCKED' | 'UNLOCKED' | 'PENDING'>('LOCKED');
  const [lastActionTime, setLastActionTime] = useState<string>('System initialized');
  const [isCommandSending, setIsCommandSending] = useState<boolean>(false);
  const [nodeOffline, setNodeOffline] = useState<boolean>(false);

  // ── Card Registry ──────────────────────────────────────────
  const [showRegistry, setShowRegistry] = useState<boolean>(false);
  const [registeredCards, setRegisteredCards] = useState<RegisteredCard[]>([]);
  const [enrollStep, setEnrollStep] = useState<EnrollStep>('idle');
  const [scannedUid, setScannedUid] = useState<string>('');
  const [cardLabel, setCardLabel] = useState<string>('');
  const [enrollError, setEnrollError] = useState<string>('');
  const [editingUid, setEditingUid] = useState<string | null>(null);

  const getEnrollTopic = useCallback((sub: string) =>
    topicPrefix
      ? `${topicPrefix}/enroll/${sub}`
      : `security/door/enroll/${sub}`,
    [topicPrefix]
  );

  // ── MQTT: door status + enroll flow ────────────────────────
  useEffect(() => {
    const client = getMqttClient();

    const onConnect = () => {
      client.subscribe('security/door/status');
      client.subscribe('security/door/enroll/scan');
      client.subscribe('security/door/enroll/ack');
      client.subscribe('security/door/enroll/list');
      if (topicPrefix) {
        client.subscribe(`${topicPrefix}/status`);
        client.subscribe(`${topicPrefix}/enroll/scan`);
        client.subscribe(`${topicPrefix}/enroll/ack`);
        client.subscribe(`${topicPrefix}/enroll/list`);
      }
    };

    const onMessage = (topic: string, message: Buffer) => {
      const msgStr = message.toString().trim();

      // ── Door status ───────────────────────────────────────
      if (topic.endsWith('/door/status') || topic.endsWith('/status')) {
        const statusStr = msgStr.toUpperCase();
        if (statusStr === 'LOCKED' || statusStr === 'UNLOCKED') {
          setLockStatus(statusStr);
          setIsCommandSending(false);
          setNodeOffline(false);
          setLastActionTime(new Date().toLocaleTimeString());
        }
        return;
      }

      // ── ESP32 published full card list on connect ─────────
      if (topic.endsWith('/enroll/list')) {
        try {
          const list: RegisteredCard[] = JSON.parse(msgStr);
          if (Array.isArray(list)) setRegisteredCards(list);
        } catch { /* ignore */ }
        return;
      }

      // ── ESP32 scanned a new card during enrollment ────────
      if (topic.endsWith('/enroll/scan')) {
        try {
          const payload = JSON.parse(msgStr);
          if (payload.uid) {
            setScannedUid(payload.uid);
            setCardLabel('');
            setEnrollStep('confirm');
          }
        } catch { /* ignore */ }
        return;
      }

      // ── ESP32 confirmed save / delete ─────────────────────
      if (topic.endsWith('/enroll/ack')) {
        try {
          const payload = JSON.parse(msgStr);
          if (payload.status === 'saved') {
            setRegisteredCards((prev) => {
              const filtered = prev.filter((c) => c.uid !== payload.uid);
              return [...filtered, { uid: payload.uid, label: payload.label || payload.uid }];
            });
            setEnrollStep('success');
            setTimeout(() => setEnrollStep('idle'), 2200);
          } else if (payload.status === 'deleted') {
            setRegisteredCards((prev) => prev.filter((c) => c.uid !== payload.uid));
          } else if (payload.status === 'error') {
            setEnrollError(payload.message || 'ESP32 returned an error.');
            setEnrollStep('error');
          }
        } catch { /* ignore */ }
        return;
      }
    };

    if (client.connected) onConnect();
    client.on('connect', onConnect);
    client.on('message', onMessage);

    return () => {
      client.off('message', onMessage);
    };
  }, [topicPrefix]);

  // ── Request list from ESP32 whenever registry opens ────────
  useEffect(() => {
    if (!showRegistry) return;
    const client = getMqttClient();
    if (client.connected) {
      client.publish(getEnrollTopic('request'), JSON.stringify({ action: 'list' }));
      if (topicPrefix) {
        client.publish('security/door/enroll/request', JSON.stringify({ action: 'list' }));
      }
    }
  }, [showRegistry, getEnrollTopic, topicPrefix]);

  // ── Door lock / unlock commands ─────────────────────────────
  const sendCommand = (cmd: 'OPEN' | 'CLOSE') => {
    const client = getMqttClient();
    const previousStatus: 'LOCKED' | 'UNLOCKED' = cmd === 'OPEN' ? 'LOCKED' : 'UNLOCKED';
    setIsCommandSending(true);
    setNodeOffline(false);
    setLockStatus('PENDING');

    client.publish('security/door/command', cmd, { qos: 1 });
    if (topicPrefix) {
      client.publish(`${topicPrefix}/command`, cmd, { qos: 1 });
    }

    setTimeout(() => {
      setIsCommandSending((sending) => {
        if (sending) {
          setLockStatus(previousStatus);
          setNodeOffline(true);
          return false;
        }
        return false;
      });
    }, 7000);
  };

  // ── Enroll: tell ESP32 to start scan mode ──────────────────
  const startEnroll = () => {
    const client = getMqttClient();
    setEnrollStep('waiting_scan');
    setScannedUid('');
    setEnrollError('');

    const payload = JSON.stringify({ action: 'start' });
    client.publish(getEnrollTopic('request'), payload);
    if (topicPrefix) {
      client.publish('security/door/enroll/request', payload);
    }

    // Timeout if no card scanned within 30s
    setTimeout(() => {
      setEnrollStep((s) => {
        if (s === 'waiting_scan') {
          setEnrollError('No card scanned within 30 seconds. Try again.');
          return 'error';
        }
        return s;
      });
    }, 30000);
  };

  // ── Enroll: confirm & save the scanned card ────────────────
  const confirmEnroll = () => {
    const client = getMqttClient();
    const label = cardLabel.trim() || scannedUid;
    setEnrollStep('saving');

    const payload = JSON.stringify({ uid: scannedUid, label });
    client.publish(getEnrollTopic('confirm'), payload);
    if (topicPrefix) {
      client.publish('security/door/enroll/confirm', payload);
    }

    // Timeout if no ack
    setTimeout(() => {
      setEnrollStep((s) => {
        if (s === 'saving') {
          setEnrollError('ESP32 did not confirm. Check MQTT connection.');
          return 'error';
        }
        return s;
      });
    }, 10000);
  };

  // ── Delete a registered card ────────────────────────────────
  const deleteCard = (uid: string) => {
    const client = getMqttClient();
    const payload = JSON.stringify({ uid });
    client.publish(getEnrollTopic('delete'), payload);
    if (topicPrefix) {
      client.publish('security/door/enroll/delete', payload);
    }
    // Optimistic UI update
    setRegisteredCards((prev) => prev.filter((c) => c.uid !== uid));
  };

  const cancelEnroll = () => {
    setEnrollStep('idle');
    setScannedUid('');
    setCardLabel('');
    setEnrollError('');
  };

  const isLocked = lockStatus === 'LOCKED' || lockStatus === 'PENDING';

  return (
    <section className="card door-card" aria-label="Access Control">
      {/* ── Card Header ────────────────────────────────────── */}
      <header className="card-header">
        <div className="card-title">
          <div className="card-title-icon">
            <KeyRound size={16} />
          </div>
          <div>
            <h3>{deviceName || 'Access Control'}</h3>
            <span className="card-subtitle">{deviceId || 'ESP32'} &bull; Deadbolt Actuator</span>
          </div>
        </div>

        <div className="header-controls">
          <div className={`status-badge status-${lockStatus.toLowerCase()}`}>
            {lockStatus === 'PENDING' ? (
              <>
                <RotateCw size={12} className="spin-icon" />
                <span>PENDING</span>
              </>
            ) : isLocked ? (
              <>
                <span className="status-dot dot-secured" />
                <span>SECURED</span>
              </>
            ) : (
              <>
                <span className="status-dot dot-unlocked" />
                <span>UNLOCKED</span>
              </>
            )}
          </div>

          {/* Card Registry toggle */}
          <button
            type="button"
            className={`btn-icon ${showRegistry ? 'active' : ''}`}
            onClick={() => setShowRegistry(!showRegistry)}
            title="Manage Registered NFC / RFID Cards"
            aria-label="Card Registry"
          >
            <CreditCard size={15} />
          </button>

          {onDelete && (
            <button
              type="button"
              className="btn-icon btn-delete"
              onClick={onDelete}
              title="Remove Lock"
              aria-label="Remove Lock"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </header>

      {/* ── Node Offline Warning ────────────────────────────── */}
      {nodeOffline && (
        <div className="node-offline-warning">
          <WifiOff size={14} />
          <span>
            <strong>Access Node unreachable.</strong> Ensure the ESP32 is online and its MQTT Broker Host is set to HiveMQ Cloud.
          </span>
        </div>
      )}

      {/* ── Lock State + Details ────────────────────────────── */}
      <div className="door-body">
        <div className={`lock-state-box ${isLocked ? 'state-secured' : 'state-unlocked'}`}>
          {isLocked ? <Lock size={22} /> : <Unlock size={22} />}
        </div>
        <div className="lock-details">
          <h4>{deviceName || 'Front Entrance Deadbolt'}</h4>
          <span className="lock-subtext">5s Pulse Auto-Relock Enabled</span>
          <span className="timestamp-label">Event: {lastActionTime}</span>
        </div>
      </div>

      {/* ── Control Button ─────────────────────────────────── */}
      <div className="door-controls">
        {isLocked ? (
          <button
            type="button"
            className="btn-control btn-unlock"
            disabled={isCommandSending}
            onClick={() => sendCommand('OPEN')}
          >
            {isCommandSending ? (
              <><RotateCw size={15} className="spin-icon" /><span>Transmitting Command...</span></>
            ) : (
              <><Unlock size={15} /><span>Unlock Door (5s Pulse)</span></>
            )}
          </button>
        ) : (
          <button
            type="button"
            className="btn-control btn-lock"
            disabled={isCommandSending}
            onClick={() => sendCommand('CLOSE')}
          >
            {isCommandSending ? (
              <><RotateCw size={15} className="spin-icon" /><span>Transmitting Command...</span></>
            ) : (
              <><Lock size={15} /><span>Engage Lock Immediately</span></>
            )}
          </button>
        )}
      </div>

      {/* ── Card Registry Panel ─────────────────────────────── */}
      {showRegistry && (
        <div className="card-registry">
          <div className="registry-header">
            <div className="registry-title">
              <CreditCard size={14} />
              <span>NFC / RFID Card Registry</span>
            </div>
            <span className="log-count-pill">{registeredCards.length} cards</span>
          </div>

          {/* Registered card list */}
          {registeredCards.length > 0 && (
            <ul className="registry-list">
              {registeredCards.map((card) => (
                <li key={card.uid} className="registry-card-item">
                  {editingUid === card.uid ? (
                    <div className="registry-edit-row">
                      <input
                        className="registry-edit-input"
                        value={cardLabel}
                        onChange={(e) => setCardLabel(e.target.value)}
                        autoFocus
                        placeholder="Card label"
                      />
                      <button
                        type="button"
                        className="btn-action-sm"
                        onClick={() => {
                          const client = getMqttClient();
                          const payload = JSON.stringify({ uid: card.uid, label: cardLabel.trim() || card.uid });
                          client.publish(getEnrollTopic('confirm'), payload);
                          setRegisteredCards((prev) =>
                            prev.map((c) => c.uid === card.uid ? { ...c, label: cardLabel.trim() || c.uid } : c)
                          );
                          setEditingUid(null);
                          setCardLabel('');
                        }}
                      >
                        <CheckCircle2 size={12} /> Save
                      </button>
                      <button
                        type="button"
                        className="btn-action-sm"
                        onClick={() => { setEditingUid(null); setCardLabel(''); }}
                      >
                        <XCircle size={12} /> Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="registry-card-info">
                        <span className="registry-card-label">{card.label}</span>
                        <span className="registry-card-uid">{card.uid}</span>
                      </div>
                      <div className="registry-card-actions">
                        <button
                          type="button"
                          className="btn-icon"
                          title="Rename card"
                          onClick={() => { setEditingUid(card.uid); setCardLabel(card.label); }}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          className="btn-icon btn-delete"
                          title="Remove card"
                          onClick={() => deleteCard(card.uid)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* ── Enroll Flow ─────────────────────────────────── */}
          {enrollStep === 'idle' && (
            <button
              type="button"
              className="btn-enroll"
              onClick={startEnroll}
            >
              <Plus size={14} />
              <span>Register New Card</span>
            </button>
          )}

          {enrollStep === 'waiting_scan' && (
            <div className="enroll-state enroll-scanning">
              <div className="enroll-scan-ring">
                <ScanLine size={22} />
              </div>
              <span className="enroll-label">Tap your NFC card on the reader now…</span>
              <button type="button" className="btn-action-sm" onClick={cancelEnroll}>
                Cancel
              </button>
            </div>
          )}

          {enrollStep === 'confirm' && (
            <div className="enroll-state enroll-confirm">
              <div className="enroll-uid-row">
                <CreditCard size={14} className="enroll-uid-icon" />
                <code className="enroll-uid-code">{scannedUid}</code>
              </div>
              <input
                className="enroll-label-input"
                type="text"
                placeholder="Card label (e.g. My NFC Tag, Spare Fob)"
                value={cardLabel}
                onChange={(e) => setCardLabel(e.target.value)}
                autoFocus
                maxLength={48}
              />
              <div className="enroll-confirm-actions">
                <button type="button" className="btn-action-sm" onClick={cancelEnroll}>
                  <XCircle size={13} /> Cancel
                </button>
                <button type="button" className="btn-enroll-save" onClick={confirmEnroll}>
                  <CheckCircle2 size={13} /> Save Card
                </button>
              </div>
            </div>
          )}

          {enrollStep === 'saving' && (
            <div className="enroll-state">
              <RotateCw size={16} className="spin-icon" />
              <span className="enroll-label">Saving to ESP32…</span>
            </div>
          )}

          {enrollStep === 'success' && (
            <div className="enroll-state enroll-success">
              <CheckCircle2 size={16} />
              <span className="enroll-label">Card registered successfully!</span>
            </div>
          )}

          {enrollStep === 'error' && (
            <div className="enroll-state enroll-error">
              <XCircle size={16} />
              <span className="enroll-label">{enrollError}</span>
              <button type="button" className="btn-action-sm" onClick={cancelEnroll}>
                Dismiss
              </button>
            </div>
          )}

          {registeredCards.length === 0 && enrollStep === 'idle' && (
            <p className="registry-empty-hint">
              No cards registered yet. Press &ldquo;Register New Card&rdquo; and tap your NFC tag on the reader.
            </p>
          )}
        </div>
      )}
    </section>
  );
};

export default DoorLock;
