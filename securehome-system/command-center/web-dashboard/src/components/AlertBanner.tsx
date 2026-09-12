'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, UserCheck, X } from 'lucide-react';
import { getMqttClient } from '../lib/mqttClient';

export const AlertBanner: React.FC = () => {
  const [alert, setAlert] = useState<{
    camera: string;
    confidence: number;
    timestamp: string;
  } | null>(null);

  useEffect(() => {
    const client = getMqttClient();

    const onConnect = () => {
      client.subscribe('security/alerts/person');
    };

    const onMessage = (topic: string, message: Buffer) => {
      if (topic === 'security/alerts/person') {
        try {
          const payload = JSON.parse(message.toString());
          setAlert({
            camera: payload.camera || 'Vision Node',
            confidence: payload.confidence ? Math.round(payload.confidence * 100) : 95,
            timestamp: payload.timestamp || new Date().toLocaleTimeString(),
          });

          // Auto-dismiss alert after 10 seconds
          const timer = setTimeout(() => {
            setAlert(null);
          }, 10000);

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
  }, []);

  if (!alert) return null;

  return (
    <div className="alert-banner">
      <div className="alert-content">
        <div className="alert-icon-wrap">
          <AlertTriangle size={22} className="alert-pulse" />
        </div>
        <div className="alert-details">
          <strong>Person Detected!</strong>
          <span>
            {alert.camera} reported human presence ({alert.confidence}% confidence) at{' '}
            {alert.timestamp}
          </span>
        </div>
      </div>
      <button className="alert-close" onClick={() => setAlert(null)} aria-label="Dismiss alert">
        <X size={18} />
      </button>
    </div>
  );
};

export default AlertBanner;
