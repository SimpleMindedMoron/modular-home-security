#!/usr/bin/env python3
"""
SecureHome AI Processor Service
Node 1 - Command Center: Person Detection Module

Consumes the ESP32-CAM MJPEG HTTP stream, performs computer vision person detection
using OpenCV HOG/SVM, and publishes alert payloads to the HiveMQ Cloud MQTT broker
over TLS (port 8883).
"""

import os
import ssl
import sys
import time
import json
import signal
import logging
from datetime import datetime
import cv2
import paho.mqtt.client as mqtt
from dotenv import load_dotenv

load_dotenv()

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger('AI-Processor')

# Configuration from Environment
MQTT_BROKER_HOST = os.getenv('MQTT_BROKER_HOST', 'localhost')
MQTT_PORT = int(os.getenv('MQTT_PORT', 8883))
MQTT_USER = os.getenv('MQTT_USER', '')
MQTT_PASS = os.getenv('MQTT_PASS', '')
CAMERA_STREAM_URL = os.getenv('CAMERA_STREAM_URL', 'http://192.168.1.145:81/stream')
TOPIC_CAMERA_DISCOVERY = os.getenv('TOPIC_CAMERA_DISCOVERY', 'security/camera/discovery')
TOPIC_PERSON_ALERT = os.getenv('TOPIC_PERSON_ALERT', 'security/alerts/person')
ALERT_COOLDOWN_SECONDS = float(os.getenv('ALERT_COOLDOWN_SECONDS', 10.0))

running = True
current_stream_url = CAMERA_STREAM_URL
last_alert_time = 0.0


def signal_handler(sig, frame):
    global running
    logger.info("Termination signal received. Shutting down gracefully...")
    running = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def on_mqtt_connect(client, userdata, flags, reason_code, properties=None):
    logger.info(f"Connected to HiveMQ Cloud at {MQTT_BROKER_HOST}:{MQTT_PORT}")
    client.subscribe(TOPIC_CAMERA_DISCOVERY)
    logger.info(f"Subscribed to dynamic camera discovery topic: {TOPIC_CAMERA_DISCOVERY}")


def on_mqtt_message(client, userdata, msg):
    global current_stream_url
    if msg.topic == TOPIC_CAMERA_DISCOVERY:
        try:
            payload = json.loads(msg.payload.decode('utf-8'))
            ip = payload.get('ip')
            port = payload.get('port', 81)
            path = payload.get('stream_path', '/stream')
            if ip:
                new_url = f"http://{ip}:{port}{path}"
                if new_url != current_stream_url:
                    logger.info(f"Camera discovery updated stream URL: {new_url}")
                    current_stream_url = new_url
        except Exception as err:
            logger.error(f"Error parsing camera discovery message: {err}")


def init_person_detector():
    """Initializes OpenCV HOG Person Detector"""
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    return hog


def main():
    global running, current_stream_url, last_alert_time

    logger.info("Initializing SecureHome AI Person Detection Service...")

    # MQTT Setup — HiveMQ Cloud requires TLS + authentication
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="securehome_ai_processor")
    client.on_connect = on_mqtt_connect
    client.on_message = on_mqtt_message

    # Enable TLS (certificate verification against system CA bundle)
    client.tls_set(cert_reqs=ssl.CERT_REQUIRED, tls_version=ssl.PROTOCOL_TLS_CLIENT)

    # Set HiveMQ Cloud credentials
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASS)

    try:
        client.connect(MQTT_BROKER_HOST, MQTT_PORT, 60)
        client.loop_start()
    except Exception as e:
        logger.error(f"Could not connect to HiveMQ Cloud at {MQTT_BROKER_HOST}:{MQTT_PORT}: {e}")
        logger.info("Check MQTT_BROKER_HOST, MQTT_USER, MQTT_PASS in your .env file.")
        return 1

    detector = init_person_detector()

    while running:
        logger.info(f"Connecting to video stream: {current_stream_url}")
        cap = cv2.VideoCapture(current_stream_url)

        if not cap.isOpened():
            logger.warning(f"Unable to open stream at {current_stream_url}. Retrying in 5 seconds...")
            for _ in range(5):
                if not running:
                    break
                time.sleep(1)
            continue

        logger.info("Successfully connected to video stream. Starting detection loop...")

        frame_count = 0
        while running:
            ret, frame = cap.read()
            if not ret or frame is None:
                logger.warning("Stream disconnected or frame read failed. Reconnecting...")
                break

            frame_count += 1
            # Skip frames to reduce CPU load: process 1 in every 3 frames
            if frame_count % 3 != 0:
                continue

            # Resize frame for faster detection
            h, w = frame.shape[:2]
            target_width = 480
            scale = target_width / float(w)
            small_frame = cv2.resize(frame, (target_width, int(h * scale)))

            # Run HOG detector
            boxes, weights = detector.detectMultiScale(
                small_frame,
                winStride=(8, 8),
                padding=(4, 4),
                scale=1.05
            )

            current_time = time.time()
            if len(boxes) > 0 and (current_time - last_alert_time) > ALERT_COOLDOWN_SECONDS:
                best_weight = max(weights) if len(weights) > 0 else 0.85
                best_box = boxes[0].tolist()

                # Scale box back to original coordinates
                orig_box = [int(coord / scale) for coord in best_box]

                alert_payload = {
                    "camera": "cam_front_door",
                    "confidence": round(float(best_weight), 2),
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                    "bbox": orig_box
                }

                client.publish(TOPIC_PERSON_ALERT, json.dumps(alert_payload), qos=0)
                logger.info(f"ALERT: Person detected! Confidence: {best_weight:.2f}. Payload published.")
                last_alert_time = current_time

            # Sleep briefly to yield CPU
            time.sleep(0.01)

        cap.release()

    client.loop_stop()
    client.disconnect()
    logger.info("AI Processor stopped.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
