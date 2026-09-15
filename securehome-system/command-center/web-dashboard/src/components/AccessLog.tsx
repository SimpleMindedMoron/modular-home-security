'use client';

import React, { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, History, CreditCard, Hash, Terminal } from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';

export interface AccessEntry {
  id: string;
  method: string;
  status: 'GRANTED' | 'DENIED';
  identifier?: string;
  timestamp: string;
}

export const AccessLog: React.FC = () => {
  const [logs, setLogs] = useState<AccessEntry[]>([]);

  useEffect(() => {
    const client = getMqttClient();

    const onConnect = () => {
      client.subscribe('security/door/access_log');
    };

    const onMessage = (topic: string, message: Buffer) => {
      if (topic === 'security/door/access_log') {
        try {
          const payload = JSON.parse(message.toString());
          const newEntry: AccessEntry = {
            id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            method: (payload.method || 'LOCAL').toUpperCase(),
            status: payload.status?.toUpperCase() === 'GRANTED' ? 'GRANTED' : 'DENIED',
            identifier: payload.identifier || 'Manual Input',
            timestamp: new Date().toLocaleTimeString(),
          };
          setLogs((prev) => [newEntry, ...prev.slice(0, 24)]);
        } catch (e) {
          console.error('[MQTT] Error parsing access log payload:', e);
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

  const renderMethodIcon = (method: string) => {
    switch (method) {
      case 'RFID':
        return <CreditCard size={12} />;
      case 'PIN':
        return <Hash size={12} />;
      case 'REMOTE':
        return <Terminal size={12} />;
      default:
        return <Hash size={12} />;
    }
  };

  return (
    <section className="card log-card" aria-label="Access Activity Log">
      <header className="card-header">
        <div className="card-title">
          <div className="card-title-icon">
            <History size={16} />
          </div>
          <div>
            <h3>Activity Log</h3>
            <span className="card-subtitle">Real-Time Access Audit</span>
          </div>
        </div>
        <span className="log-count-pill">{logs.length} events</span>
      </header>

      <div className="log-list">
        {logs.length === 0 ? (
          <div className="empty-logs">
            <History size={28} className="empty-log-icon" />
            <p className="empty-log-title">No Events Recorded</p>
            <span className="empty-log-desc">
              Scan an NFC card or enter a PIN on the Access Node to log events.
            </span>
          </div>
        ) : (
          logs.map((entry) => (
            <article
              key={entry.id}
              className={`log-item log-item-${entry.status.toLowerCase()}`}
            >
              <div className="log-method-badge">
                {renderMethodIcon(entry.method)}
                <span>{entry.method}</span>
              </div>

              <div className="log-info">
                <span className="log-identifier">{entry.identifier}</span>
                <span className="log-timestamp">{entry.timestamp}</span>
              </div>

              <div className={`log-verdict verdict-${entry.status.toLowerCase()}`}>
                {entry.status === 'GRANTED' ? (
                  <>
                    <ShieldCheck size={13} />
                    <span>Granted</span>
                  </>
                ) : (
                  <>
                    <ShieldAlert size={13} />
                    <span>Denied</span>
                  </>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
};

export default AccessLog;
