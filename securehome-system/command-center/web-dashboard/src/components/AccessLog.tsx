'use client';

import React, { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, History, CreditCard, Hash, Terminal } from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';

export interface AccessEntry {
  id: string;
  method: string;
  status: 'GRANTED' | 'DENIED';
  identifier?: string;
  timestamp: string;
}

interface AccessLogProps {
  claimToken?: string;
  userId?: string;
}

export const AccessLog: React.FC<AccessLogProps> = ({ claimToken, userId }) => {
  const [logs, setLogs] = useState<AccessEntry[]>([]);

  // Load past logs from Supabase on mount
  useEffect(() => {
    const loadPastLogs = async () => {
      if (!isSupabaseConfigured() || !userId) return;
      try {
        const { data, error } = await supabase
          .from('access_logs')
          .select('*')
          .eq('user_id', userId)
          .order('timestamp', { ascending: false })
          .limit(25);
        if (data && !error && data.length > 0) {
          const formatted: AccessEntry[] = data.map((d) => ({
            id: d.id,
            method: (d.user_name?.includes('PIN') ? 'PIN' : d.user_name?.includes('Dashboard') ? 'REMOTE' : 'RFID'),
            status: d.granted ? 'GRANTED' : 'DENIED',
            identifier: d.rfid_tag || 'Keycard',
            timestamp: new Date(d.timestamp).toLocaleTimeString(),
          }));
          setLogs(formatted);
        }
      } catch (err) {
        console.error('Failed to load past access logs from Supabase:', err);
      }
    };
    loadPastLogs();
  }, [userId]);

  useEffect(() => {
    const client = getMqttClient();

    const onConnect = () => {
      client.subscribe('security/door/access_log');
      if (claimToken) {
        client.subscribe(`users/${claimToken}/doors/+/access_log`);
      }
    };

    const onMessage = async (topic: string, message: Buffer) => {
      if (topic === 'security/door/access_log' || topic.endsWith('/access_log')) {
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

          // Persist to Supabase if authenticated
          if (isSupabaseConfigured() && userId) {
            await supabase.from('access_logs').insert([
              {
                user_id: userId,
                rfid_tag: payload.identifier || 'Manual Input',
                user_name:
                  payload.method === 'PIN'
                    ? 'PIN User'
                    : payload.method === 'REMOTE'
                    ? 'Dashboard Remote'
                    : 'Keycard User',
                granted: payload.status?.toUpperCase() === 'GRANTED',
              },
            ]);
          }
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
  }, [claimToken, userId]);

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
