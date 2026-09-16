#!/usr/bin/env python3
"""
SecureHome AI Processor Service
Node 1 - Command Center: Person Detection Module

Responsibilities:
  1. MJPEG Stream Relay  — Re-serves the local ESP32-CAM stream on a local HTTP
                           port and exposes it globally via an ngrok HTTPS tunnel.
                           Publishes the public relay URL to HiveMQ Cloud so the
                           dashboard can load the camera feed from any network.

  2. Person Detection    — Consumes the same MJPEG stream with OpenCV HOG/SVM and
                           publishes alert payloads to HiveMQ Cloud MQTT over TLS.
"""

import os
import ssl
import sys
import time
import json
import signal
import logging
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import paho.mqtt.client as mqtt
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger('AI-Processor')

# ---------------------------------------------------------------------------
# Configuration from Environment
# ---------------------------------------------------------------------------
MQTT_BROKER_HOST          = os.getenv('MQTT_BROKER_HOST', 'localhost')
MQTT_PORT                 = int(os.getenv('MQTT_PORT', 8883))
MQTT_USER                 = os.getenv('MQTT_USER', '')
MQTT_PASS                 = os.getenv('MQTT_PASS', '')
CAMERA_STREAM_URL         = os.getenv('CAMERA_STREAM_URL', 'http://192.168.1.145:81/stream')
TOPIC_CAMERA_DISCOVERY    = os.getenv('TOPIC_CAMERA_DISCOVERY', 'security/camera/discovery')
TOPIC_CAMERA_RELAY        = os.getenv('TOPIC_CAMERA_RELAY', 'security/camera/relay_url')
TOPIC_PERSON_ALERT        = os.getenv('TOPIC_PERSON_ALERT', 'security/alerts/person')
ALERT_COOLDOWN_SECONDS    = float(os.getenv('ALERT_COOLDOWN_SECONDS', 10.0))
RELAY_PORT                = int(os.getenv('RELAY_PORT', 8765))
NGROK_AUTHTOKEN           = os.getenv('NGROK_AUTHTOKEN', '')

# Multi-tenant Claim Token & Device UID
CLAIM_TOKEN               = os.getenv('CLAIM_TOKEN', '').strip()
DEVICE_UID                = os.getenv('DEVICE_UID', 'ESP32_CAM_01').strip()

if CLAIM_TOKEN:
    SCOPED_TOPIC_DISCOVERY = f"users/{CLAIM_TOKEN}/cameras/+/discovery"
    SCOPED_TOPIC_RELAY     = f"users/{CLAIM_TOKEN}/cameras/{DEVICE_UID}/relay_url"
    SCOPED_TOPIC_ALERT     = f"users/{CLAIM_TOKEN}/alerts/person"
else:
    SCOPED_TOPIC_DISCOVERY = None
    SCOPED_TOPIC_RELAY     = None
    SCOPED_TOPIC_ALERT     = None

# ---------------------------------------------------------------------------
# Shared State (thread-safe via a lock)
# ---------------------------------------------------------------------------
running            = True
current_stream_url = CAMERA_STREAM_URL
last_alert_time    = 0.0
stream_lock        = threading.Lock()   # guards current_stream_url


def get_stream_url():
    with stream_lock:
        return current_stream_url


def set_stream_url(url: str):
    global current_stream_url
    with stream_lock:
        current_stream_url = url


# ---------------------------------------------------------------------------
# Graceful Shutdown
# ---------------------------------------------------------------------------
def signal_handler(sig, frame):
    global running
    logger.info("Termination signal received. Shutting down gracefully...")
    running = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ---------------------------------------------------------------------------
# MQTT Callbacks
# ---------------------------------------------------------------------------
def on_mqtt_connect(client, userdata, flags, reason_code, properties=None):
    logger.info(f"Connected to HiveMQ Cloud at {MQTT_BROKER_HOST}:{MQTT_PORT}")
    client.subscribe(TOPIC_CAMERA_DISCOVERY)
    logger.info(f"Subscribed to camera discovery topic: {TOPIC_CAMERA_DISCOVERY}")
    if SCOPED_TOPIC_DISCOVERY:
        client.subscribe(SCOPED_TOPIC_DISCOVERY)
        logger.info(f"Subscribed to scoped discovery topic: {SCOPED_TOPIC_DISCOVERY}")


def on_mqtt_message(client, userdata, msg):
    if msg.topic == TOPIC_CAMERA_DISCOVERY or msg.topic.endswith('/discovery'):
        try:
            payload = json.loads(msg.payload.decode('utf-8'))
            ip      = payload.get('ip')
            port    = payload.get('port', 81)
            path    = payload.get('stream_path', '/stream')
            node_id = payload.get('node_id', '')
            # If scoped to a specific device, only match that device if specified
            if ip and (not DEVICE_UID or not node_id or node_id == DEVICE_UID or node_id == 'cam_front_door'):
                new_url = f"http://{ip}:{port}{path}"
                if new_url != get_stream_url():
                    logger.info(f"Camera discovery ({node_id}) -> updated relay source: {new_url}")
                    set_stream_url(new_url)
        except Exception as err:
            logger.error(f"Error parsing camera discovery message: {err}")


# ---------------------------------------------------------------------------
# MJPEG Relay HTTP Server
# ---------------------------------------------------------------------------
MJPEG_BOUNDARY = b"--mjpegframe"


class MJPEGRelayHandler(BaseHTTPRequestHandler):
    """
    Serves the ESP32-CAM MJPEG stream at /stream by pulling frames from the
    local camera URL and forwarding them as a standard multipart MJPEG response.
    Works from any network once exposed via ngrok.
    """

    def log_message(self, format, *args):
        # Suppress per-request access logs to keep terminal clean
        pass

    def do_GET(self):
        if self.path not in ('/stream', '/'):
            self.send_error(404)
            return

        self.send_response(200)
        self.send_header('Content-Type',
                         f'multipart/x-mixed-replace; boundary={MJPEG_BOUNDARY.decode()}')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        logger.info(f"[Relay] Client connected from {self.client_address[0]}")

        cap = None
        try:
            while running:
                source = get_stream_url()
                if cap is None or not cap.isOpened():
                    if cap is not None:
                        cap.release()
                    cap = cv2.VideoCapture(source)
                    if not cap.isOpened():
                        time.sleep(2)
                        continue

                ret, frame = cap.read()
                if not ret or frame is None:
                    cap.release()
                    cap = None
                    time.sleep(1)
                    continue

                # Re-open if source URL changed (camera discovery updated it)
                if source != get_stream_url():
                    cap.release()
                    cap = None
                    continue

                ok, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if not ok:
                    continue

                data = jpeg.tobytes()
                try:
                    self.wfile.write(
                        MJPEG_BOUNDARY + b"\r\n"
                        b"Content-Type: image/jpeg\r\n" +
                        f"Content-Length: {len(data)}\r\n\r\n".encode() +
                        data + b"\r\n"
                    )
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    logger.info("[Relay] Client disconnected.")
                    break

        finally:
            if cap is not None:
                cap.release()


def start_relay_server():
    """Starts the MJPEG relay HTTP server in a daemon thread."""
    server = ThreadingHTTPServer(('0.0.0.0', RELAY_PORT), MJPEGRelayHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    logger.info(f"[Relay] MJPEG relay server listening on http://0.0.0.0:{RELAY_PORT}/stream")
    return server


# ---------------------------------------------------------------------------
# ngrok Tunnel
# ---------------------------------------------------------------------------
def start_ngrok_tunnel(mqtt_client):
    """
    Opens an ngrok HTTP tunnel to the local relay port.
    Publishes the public HTTPS URL to MQTT (retained) and returns it.
    Returns None if no authtoken is configured.
    """
    if not NGROK_AUTHTOKEN:
        logger.warning(
            "[ngrok] NGROK_AUTHTOKEN not set in .env -- skipping tunnel. "
            "Camera stream will only work on the local network.\n"
            "  -> Get a free token at: https://dashboard.ngrok.com/get-started/your-authtoken"
        )
        return None

    try:
        from pyngrok import ngrok, conf as ngrok_conf
        ngrok_conf.get_default().auth_token = NGROK_AUTHTOKEN

        tunnel    = ngrok.connect(RELAY_PORT, "http")
        # ngrok returns http:// -- upgrade to https:// for browser CORS compatibility
        pub_url   = tunnel.public_url.replace("http://", "https://")
        relay_url = f"{pub_url}/stream"

        logger.info(f"[ngrok] Tunnel open -> {relay_url}")

        # Publish retained so dashboard gets it immediately on connect
        payload = json.dumps({"url": relay_url, "source": "ngrok", "device_uid": DEVICE_UID})
        mqtt_client.publish(TOPIC_CAMERA_RELAY, payload, qos=1, retain=True)
        logger.info(f"[MQTT] Published relay URL to {TOPIC_CAMERA_RELAY}")

        if SCOPED_TOPIC_RELAY:
            mqtt_client.publish(SCOPED_TOPIC_RELAY, payload, qos=1, retain=True)
            logger.info(f"[MQTT] Published scoped relay URL to {SCOPED_TOPIC_RELAY}")

        return relay_url

    except Exception as e:
        logger.error(f"[ngrok] Failed to open tunnel: {e}")
        return None


# ---------------------------------------------------------------------------
# Person Detection
# ---------------------------------------------------------------------------
def init_person_detector():
    """Initializes OpenCV HOG Person Detector."""
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    return hog


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    global last_alert_time

    logger.info("=" * 50)
    logger.info(" SecureHome AI Processor Service")
    logger.info("=" * 50)

    # ------------------------------------------------------------------
    # 1. MQTT Client -- HiveMQ Cloud (TLS + auth)
    # ------------------------------------------------------------------
    mqtt_client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="securehome_ai_processor"
    )
    mqtt_client.on_connect = on_mqtt_connect
    mqtt_client.on_message = on_mqtt_message
    mqtt_client.tls_set(cert_reqs=ssl.CERT_REQUIRED, tls_version=ssl.PROTOCOL_TLS_CLIENT)
    if MQTT_USER:
        mqtt_client.username_pw_set(MQTT_USER, MQTT_PASS)

    try:
        mqtt_client.connect(MQTT_BROKER_HOST, MQTT_PORT, 60)
        mqtt_client.loop_start()
    except Exception as e:
        logger.error(f"Could not connect to HiveMQ Cloud at {MQTT_BROKER_HOST}:{MQTT_PORT}: {e}")
        logger.info("Check MQTT_BROKER_HOST, MQTT_USER, MQTT_PASS in your .env file.")
        return 1

    # ------------------------------------------------------------------
    # 2. MJPEG Relay Server (background thread)
    # ------------------------------------------------------------------
    start_relay_server()

    # ------------------------------------------------------------------
    # 3. ngrok Tunnel -- publish public URL to MQTT
    # ------------------------------------------------------------------
    # Brief pause so MQTT connect callback fires before we publish
    time.sleep(2)
    start_ngrok_tunnel(mqtt_client)

    # ------------------------------------------------------------------
    # 4. Person Detection Loop (main thread)
    # ------------------------------------------------------------------
    logger.info("Starting person detection loop...")
    detector = init_person_detector()

    while running:
        source = get_stream_url()
        logger.info(f"[Detection] Connecting to stream: {source}")
        cap = cv2.VideoCapture(source)

        if not cap.isOpened():
            logger.warning("[Detection] Unable to open stream. Retrying in 5s...")
            for _ in range(5):
                if not running:
                    break
                time.sleep(1)
            continue

        logger.info("[Detection] Stream opened. Running detection...")
        frame_count = 0

        while running:
            # Re-open if camera URL changed
            if source != get_stream_url():
                logger.info("[Detection] Stream URL updated -- reconnecting...")
                break

            ret, frame = cap.read()
            if not ret or frame is None:
                logger.warning("[Detection] Frame read failed. Reconnecting...")
                break

            frame_count += 1
            if frame_count % 3 != 0:
                continue

            # Resize for faster detection
            h, w     = frame.shape[:2]
            target_w = 480
            scale    = target_w / float(w)
            small    = cv2.resize(frame, (target_w, int(h * scale)))

            boxes, weights = detector.detectMultiScale(
                small, winStride=(8, 8), padding=(4, 4), scale=1.05
            )

            now = time.time()
            if len(boxes) > 0 and (now - last_alert_time) > ALERT_COOLDOWN_SECONDS:
                best_weight = max(weights) if len(weights) > 0 else 0.85
                best_box    = boxes[0].tolist()
                orig_box    = [int(c / scale) for c in best_box]

                alert_payload = {
                    "camera":     DEVICE_UID,
                    "confidence": round(float(best_weight), 2),
                    "timestamp":  datetime.utcnow().isoformat() + "Z",
                    "bbox":       orig_box,
                }
                alert_json = json.dumps(alert_payload)
                mqtt_client.publish(TOPIC_PERSON_ALERT, alert_json, qos=0)
                if SCOPED_TOPIC_ALERT:
                    mqtt_client.publish(SCOPED_TOPIC_ALERT, alert_json, qos=0)
                logger.info(f"[Detection] ALERT: Person detected on {DEVICE_UID}! Confidence: {best_weight:.2f}")
                last_alert_time = now

            time.sleep(0.01)

        cap.release()

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------
    mqtt_client.loop_stop()
    mqtt_client.disconnect()

    if NGROK_AUTHTOKEN:
        try:
            from pyngrok import ngrok
            ngrok.kill()
        except Exception:
            pass

    logger.info("AI Processor stopped.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
