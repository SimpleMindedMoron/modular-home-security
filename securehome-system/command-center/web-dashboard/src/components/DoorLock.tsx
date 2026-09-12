'use client';

import React, { useEffect, useState } from 'react';
import { Lock, Unlock, ShieldAlert, KeyRound } from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';

export const DoorLock: React.FC = () => {
  const [lockStatus, setLockStatus] = useState<'LOCKED' | 'UNLOCKED' | 'PENDING'>('LOCKED');
  const [lastActionTime, setLastActionTime] = useState<string>('System initialized');
  const [isCommandSending, setIsCommandSending] = useState<boolean>(false);

  useEffect(() => {
    const client = getMqttClient();

    const onConnect = () => {
      client.subscribe('security/door/status');
    };

    const onMessage = (topic: string, message: Buffer) => {
      if (topic === 'security/door/status') {
        const statusStr = message.toString().trim().toUpperCase();
        if (statusStr === 'LOCKED' || statusStr === 'UNLOCKED') {
          setLockStatus(statusStr);
          setIsCommandSending(false);
          setLastActionTime(new Date().toLocaleTimeString());
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

  const sendCommand = (cmd: 'OPEN' | 'CLOSE') => {
    const client = getMqttClient();
    setIsCommandSending(true);
    setLockStatus('PENDING');

    client.publish('security/door/command', cmd, { qos: 1 }, (err) => {
      if (err) {
        console.error('[MQTT] Failed to publish door command:', err);
        setIsCommandSending(false);
      }
    });

    // Optimistic fallback after 6 seconds if status doesn't arrive
    setTimeout(() => {
      setIsCommandSending(false);
    }, 6000);
  };

  const isLocked = lockStatus === 'LOCKED';

  return (
    <div className={`card door-card ${isLocked ? 'state-locked' : 'state-unlocked'}`}>
      <div className="card-header">
        <div className="card-title">
          <KeyRound className="icon" size={20} />
          <h3>Access Control</h3>
        </div>
        <span className={`status-pill pill-${lockStatus.toLowerCase()}`}>
          {lockStatus}
        </span>
      </div>

      <div className="door-body">
        <div className={`lock-icon-wrapper ${isLocked ? 'locked' : 'unlocked'}`}>
          {isLocked ? <Lock size={56} /> : <Unlock size={56} />}
        </div>
        <div className="lock-info">
          <h4>Front Entrance Deadbolt</h4>
          <p className="timestamp-label">Last event: {lastActionTime}</p>
        </div>
      </div>

      <div className="door-controls">
        {isLocked ? (
          <button
            className="btn btn-unlock"
            disabled={isCommandSending}
            onClick={() => sendCommand('OPEN')}
          >
            <Unlock size={18} />
            {isCommandSending ? 'Unlocking...' : 'Unlock Door (5s Pulse)'}
          </button>
        ) : (
          <button
            className="btn btn-lock"
            disabled={isCommandSending}
            onClick={() => sendCommand('CLOSE')}
          >
            <Lock size={18} />
            {isCommandSending ? 'Locking...' : 'Force Lock'}
          </button>
        )}
      </div>
    </div>
  );
};

export default DoorLock;
