import mqtt, { MqttClient } from 'mqtt';

let client: MqttClient | null = null;

export const getMqttClient = (): MqttClient => {
  if (client) {
    return client;
  }

  const brokerUrl =
    process.env.NEXT_PUBLIC_MQTT_BROKER_URL || 'wss://3f93b8059c60417c83f4edf58d1fa61d.s1.eu.hivemq.cloud:8884/mqtt';

  client = mqtt.connect(brokerUrl, {
    clientId: `securehome_web_${Math.random().toString(16).substring(2, 8)}`,
    username: process.env.NEXT_PUBLIC_MQTT_USER || 'simplicity005',
    password: process.env.NEXT_PUBLIC_MQTT_PASS || 'Hey@Simplicity',
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 8000,
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected to HiveMQ Cloud at', brokerUrl);
  });

  client.on('error', (err) => {
    console.error('[MQTT] Connection error:', err);
  });

  client.on('offline', () => {
    console.warn('[MQTT] Client offline — retrying...');
  });

  return client;
};
