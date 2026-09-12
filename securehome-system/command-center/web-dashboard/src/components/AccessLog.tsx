'use client';

import React, { useEffect, useState } from 'react';
import { ShieldCheck, ShieldX, History, CreditCard, Hash } from 'lucide-react';
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
            id: `${Date.now()}_${Math.random()}`,
            method: payload.method || 'UNKNOWN',
            status: payload.status?.toUpperCase() === 'GRANTED' ? 'GRANTED' : 'DENIED',
            identifier: payload.identifier || 'Local Input',
            timestamp: new Date().toLocaleTimeString(),
          };
          setLogs((prev) => [newEntry, ...prev.slice(0, 19)]);
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

  return (
    <div className="card log-card">
      <div className="card-header">
        <div className="card-title">
          <History className="icon" size={20} />
          <h3>Live Access Activity</h3>
        </div>
        <span className="log-count-badge">{logs.length} events</span>
      </div>

      <div className="log-list">
        {logs.length === 0 ? (
          <div className="empty-logs">
            <p>No entry events recorded yet</p>
            <span>Scan an NFC card or enter a PIN on the Access Node</span>
          </div>
        ) : (
          logs.map((entry) => (
            <div
              key={entry.id}
              className={`log-item ${entry.status === 'GRANTED' ? 'log-granted' : 'log-denied'}`}
            >
              <div className="log-icon">
                {entry.status === 'GRANTED' ? (
                  <ShieldCheck size={18} className="granted-icon" />
                ) : (
                  <ShieldX size={18} className="denied-icon" />
                )}
              </div>
              <div className="log-details">
                <div className="log-primary">
                  <span className="method-tag">
                    {entry.method === 'RFID' ? <CreditCard size={12} /> : <Hash size={12} />}
                    {entry.method}
                  </span>
                  <span className={`status-text status-${entry.status.toLowerCase()}`}>
                    {entry.status}
                  </span>
                </div>
                <span className="log-meta">
                  {entry.identifier} &bull; {entry.timestamp}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default AccessLog;
