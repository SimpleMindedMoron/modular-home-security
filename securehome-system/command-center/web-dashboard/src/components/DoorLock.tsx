'use client';

import React, { useEffect, useState } from 'react';
import { Lock, Unlock, KeyRound, RotateCw, WifiOff } from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';

export const DoorLock: React.FC = () => {
  const [lockStatus, setLockStatus] = useState<'LOCKED' | 'UNLOCKED' | 'PENDING'>('LOCKED');
  const [lastActionTime, setLastActionTime] = useState<string>('System initialized');
  const [isCommandSending, setIsCommandSending] = useState<boolean>(false);
  const [nodeOffline, setNodeOffline] = useState<boolean>(false);

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
          setNodeOffline(false);
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
    // Remember the stable state before PENDING so we can revert on timeout
    const previousStatus: 'LOCKED' | 'UNLOCKED' = cmd === 'OPEN' ? 'LOCKED' : 'UNLOCKED';

    setIsCommandSending(true);
    setNodeOffline(false);
    setLockStatus('PENDING');

    client.publish('security/door/command', cmd, { qos: 1 }, (err) => {
      if (err) {
        console.error('[MQTT] Failed to publish door command:', err);
        setIsCommandSending(false);
        setLockStatus(previousStatus);
      }
    });

    // If the Access Node doesn't respond within 7s, revert UI and show a warning
    setTimeout(() => {
      setIsCommandSending((sending) => {
        if (sending) {
          console.warn(
            '[DoorLock] No acknowledgement from Access Node within 7s. ' +
            'Ensure the ESP32 is on the SAME Wi-Fi network as this machine, ' +
            'and that its MQTT Broker IP matches this server.'
          );
          setLockStatus(previousStatus);
          setNodeOffline(true);
        }
        return false;
      });
    }, 7000);
  };

  const isLocked = lockStatus === 'LOCKED';

  return (
    <section className="card door-card" aria-label="Access Control">
      <header className="card-header">
        <div className="card-title">
          <div className="card-title-icon">
            <KeyRound size={16} />
          </div>
          <div>
            <h3>Access Control</h3>
            <span className="card-subtitle">Node 03 &bull; Deadbolt Actuator</span>
          </div>
        </div>

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
      </header>

      {nodeOffline && (
        <div className="node-offline-warning">
          <WifiOff size={14} />
          <span>
            <strong>Access Node unreachable.</strong> Ensure the ESP32 is online and its MQTT Broker Host is set to{' '}
            <code>3f93b8059c60417c83f4edf58d1fa61d.s1.eu.hivemq.cloud</code>.
          </span>
        </div>
      )}

      <div className="door-body">
        <div className={`lock-state-box ${isLocked ? 'state-secured' : 'state-unlocked'}`}>
          {isLocked ? <Lock size={22} /> : <Unlock size={22} />}
        </div>
        <div className="lock-details">
          <h4>Front Entrance Deadbolt</h4>
          <span className="lock-subtext">5s Pulse Auto-Relock Enabled</span>
          <span className="timestamp-label">Event: {lastActionTime}</span>
        </div>
      </div>

      <div className="door-controls">
        {isLocked ? (
          <button
            type="button"
            className="btn-control btn-unlock"
            disabled={isCommandSending}
            onClick={() => sendCommand('OPEN')}
          >
            {isCommandSending ? (
              <>
                <RotateCw size={15} className="spin-icon" />
                <span>Transmitting Command...</span>
              </>
            ) : (
              <>
                <Unlock size={15} />
                <span>Unlock Door (5s Pulse)</span>
              </>
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
              <>
                <RotateCw size={15} className="spin-icon" />
                <span>Transmitting Command...</span>
              </>
            ) : (
              <>
                <Lock size={15} />
                <span>Engage Lock Immediately</span>
              </>
            )}
          </button>
        )}
      </div>
    </section>
  );
};

export default DoorLock;
