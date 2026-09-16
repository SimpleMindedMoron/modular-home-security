'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, X, ShieldAlert } from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';

interface AlertBannerProps {
  claimToken?: string;
  userId?: string;
}

export const AlertBanner: React.FC<AlertBannerProps> = ({ claimToken, userId }) => {
  const [alert, setAlert] = useState<{
    camera: string;
    confidence: number;
    timestamp: string;
  } | null>(null);

  useEffect(() => {
    const client = getMqttClient();

    const onConnect = () => {
      client.subscribe('security/alerts/person');
      if (claimToken) {
        client.subscribe(`users/${claimToken}/alerts/person`);
      }
    };

    const onMessage = async (topic: string, message: Buffer) => {
      if (topic === 'security/alerts/person' || topic.endsWith('/alerts/person')) {
        try {
          const payload = JSON.parse(message.toString());
          const cameraName = payload.camera || 'Front Camera';
          const conf = payload.confidence ? Math.round(payload.confidence * 100) : 95;
          const time = payload.timestamp || new Date().toLocaleTimeString();

          setAlert({
            camera: cameraName,
            confidence: conf,
            timestamp: time,
          });

          // Persist to Supabase if authenticated
          if (isSupabaseConfigured() && userId) {
            await supabase.from('alerts').insert([
              {
                user_id: userId,
                alert_type: 'person_detected',
                confidence: payload.confidence || 0.95,
              },
            ]);
          }

          // Auto-dismiss alert after 12 seconds
          const timer = setTimeout(() => {
            setAlert(null);
          }, 12000);

          return () => clearTimeout(timer);
        } catch (e) {
          console.error('[MQTT] Failed to parse alert message:', e);
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

  if (!alert) return null;

  return (
    <aside className="alert-strip" role="alert" aria-live="assertive">
      <div className="alert-strip-content">
        <div className="alert-strip-badge">
          <AlertTriangle size={14} />
          <span>SECURITY ALERT</span>
        </div>
        <p className="alert-strip-message">
          <strong>Person Detected:</strong> {alert.camera} detected human presence ({alert.confidence}% confidence) at{' '}
          <span className="alert-strip-time">{alert.timestamp}</span>.
        </p>
      </div>
      <button
        type="button"
        className="alert-strip-dismiss"
        onClick={() => setAlert(null)}
        aria-label="Dismiss security alert"
      >
        <X size={15} />
      </button>
    </aside>
  );
};

export default AlertBanner;
