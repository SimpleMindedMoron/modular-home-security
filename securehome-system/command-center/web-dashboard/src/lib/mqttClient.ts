import mqtt, { MqttClient } from 'mqtt';

let client: MqttClient | null = null;

export const getMqttClient = (): MqttClient => {
  if (client) {
    return client;
  }

  const brokerUrl =
    process.env.NEXT_PUBLIC_MQTT_BROKER_URL || 'ws://localhost:9001';

  client = mqtt.connect(brokerUrl, {
    clientId: `securehome_web_${Math.random().toString(16).substring(2, 8)}`,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 5000,
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected to broker at', brokerUrl);
  });

  client.on('error', (err) => {
    console.error('[MQTT] Connection error:', err);
  });

  client.on('offline', () => {
    console.warn('[MQTT] Client offline');
  });

  return client;
};
