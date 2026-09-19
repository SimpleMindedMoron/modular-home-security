#!/usr/bin/env python3
"""
SecureHome AI Processor Service
Node 1 - Command Center: Multi-threaded MJPEG Relay & Person Detection Module

Architecture:
  Thread 1: Camera Ingestion Thread   — Dedicated, single connection to ESP32-CAM.
                                        Captures frames in real-time, caches latest JPEG.
  Thread 2: AI Detection Worker       — Runs OpenCV HOG person detection on cached frames
                                        independently without blocking the video stream.
  Thread 3: ThreadingHTTPServer       — Serves MJPEG stream (/stream) & web preview (/)
                                        from memory to local clients & ngrok tunnel.
"""

import os
import ssl
import sys
import time
import json
import signal
import logging
import threading
from datetime import datetime, timezone
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
# Shared State (thread-safe)
# ---------------------------------------------------------------------------
running            = True
current_stream_url = CAMERA_STREAM_URL
last_alert_time    = 0.0
stream_lock        = threading.Lock()   # guards current_stream_url

latest_frame_bytes = None
latest_cv_frame    = None
frame_lock         = threading.Lock()
frame_cond         = threading.Condition(frame_lock)


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
            if ip and (not DEVICE_UID or not node_id or node_id == DEVICE_UID or node_id == 'cam_front_door'):
                new_url = f"http://{ip}:{port}{path}"
                if new_url != get_stream_url():
                    logger.info(f"Camera discovery ({node_id}) -> updated relay source: {new_url}")
                    set_stream_url(new_url)
        except Exception as err:
            logger.error(f"Error parsing camera discovery message: {err}")


# ---------------------------------------------------------------------------
# HTML Preview Page Template (for browser tabs loading root /)
# ---------------------------------------------------------------------------
HTML_VIEWER_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SecureHome Camera Stream</title>
  <style>
    body {
      background: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: center;
      margin: 0;
      padding: 24px;
    }
    h2 { margin-bottom: 6px; }
    p { color: #94a3b8; font-size: 14px; margin-top: 0; }
    .badge {
      display: inline-block;
      background: rgba(16, 185, 129, 0.15);
      color: #10b981;
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
    }
    .stream-container {
      max-width: 800px;
      margin: 0 auto;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 35px rgba(0,0,0,0.6);
      border: 1px solid #334155;
      background: #000;
    }
    img {
      width: 100%;
      height: auto;
      display: block;
    }
  </style>
</head>
<body>
  <div class="badge">● LIVE RELAY ACTIVE</div>
  <h2>SecureHome Vision Node</h2>
  <p>Live MJPEG Stream via ngrok Relay</p>
  <div class="stream-container">
    <img src="/stream" alt="ESP32-CAM Live Feed" />
  </div>
</body>
</html>"""


# ---------------------------------------------------------------------------
# MJPEG Relay HTTP Server
# ---------------------------------------------------------------------------
MJPEG_BOUNDARY = b"--mjpegframe"


class MJPEGRelayHandler(BaseHTTPRequestHandler):
    """
    Serves the ESP32-CAM MJPEG stream at /stream by forwarding in-memory
    JPEG frames captured by the dedicated camera capture thread.
    Prevents opening multiple connections to the ESP32-CAM.
    """

    def log_message(self, format, *args):
        # Suppress per-request access logs to keep terminal clean
        pass

    def do_GET(self):
        # Extract clean path without query parameters (e.g. /stream?_t=123 -> /stream)
        clean_path = self.path.split('?')[0].rstrip('/')
        if not clean_path:
            clean_path = '/'

        # 1. Root preview page
        if clean_path == '/':
            page_data = HTML_VIEWER_PAGE.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(page_data)))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(page_data)
            return

        # 2. Single JPEG snapshot
        if clean_path in ('/snapshot', '/frame.jpg'):
            with frame_cond:
                data = latest_frame_bytes
            if data is None:
                self.send_error(503, "Camera frame not ready")
                return
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.end_headers()
            self.wfile.write(data)
            return

        # 3. Live multipart MJPEG stream (matches /stream or /stream?...)
        if clean_path == '/stream':
            self.send_response(200)
            self.send_header('Content-Type',
                             f'multipart/x-mixed-replace; boundary={MJPEG_BOUNDARY.decode()}')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.end_headers()

            logger.info(f"[Relay] Client connected from {self.client_address[0]}")

            try:
                while running:
                    with frame_cond:
                        # Wait for a new frame from camera_capture_worker
                        if not frame_cond.wait(timeout=1.0):
                            continue
                        data = latest_frame_bytes

                    if data is None:
                        continue

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
            except Exception as e:
                logger.debug(f"[Relay] Client handler error: {e}")
            return

        self.send_error(404)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_relay_server():
    """Starts the MJPEG relay HTTP server in a daemon thread."""
    server = ReusableThreadingHTTPServer(('0.0.0.0', RELAY_PORT), MJPEGRelayHandler)
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
        pub_url   = tunnel.public_url.replace("http://", "https://")
        relay_url = f"{pub_url}/stream"

        logger.info(f"[ngrok] Tunnel open -> {relay_url}")

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
# Camera Ingestion Worker Thread (Single persistent connection to ESP32)
# ---------------------------------------------------------------------------
def camera_capture_worker():
    """
    Dedicated thread that maintains ONE single persistent connection to the ESP32-CAM.
    Drains frames continuously to prevent lag and buffer buildup.
    Updates in-memory latest_frame_bytes and latest_cv_frame for relay and AI detection.
    """
    global latest_frame_bytes, latest_cv_frame

    logger.info("[Capture] Camera capture worker thread started.")

    while running:
        source = get_stream_url()
        logger.info(f"[Capture] Connecting to camera stream: {source}")
        cap = cv2.VideoCapture(source)

        if not cap.isOpened():
            logger.warning("[Capture] Unable to open camera stream. Retrying in 5s...")
            for _ in range(5):
                if not running:
                    break
                time.sleep(1)
            continue

        logger.info("[Capture] Camera stream connected successfully.")

        while running:
            # If discovery updated the stream URL, reconnect
            if source != get_stream_url():
                logger.info("[Capture] Stream URL updated -- reconnecting...")
                break

            ret, frame = cap.read()
            if not ret or frame is None:
                logger.warning("[Capture] Frame read failed. Reconnecting...")
                time.sleep(1)
                break

            # Encode frame to JPEG buffer for relay clients
            ok, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok:
                jpeg_bytes = jpeg.tobytes()
                with frame_cond:
                    latest_frame_bytes = jpeg_bytes
                    latest_cv_frame = frame
                    frame_cond.notify_all()

        cap.release()

    logger.info("[Capture] Camera capture worker thread stopped.")


# ---------------------------------------------------------------------------
# AI Person Detection Worker Thread (Non-blocking)
# ---------------------------------------------------------------------------
def init_person_detector():
    """Initializes OpenCV HOG Person Detector."""
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    return hog


def ai_detection_worker(mqtt_client):
    """
    Dedicated thread for OpenCV person detection.
    Pulls the latest frame from memory and runs HOG detection independently,
    without stalling or blocking the video stream!
    """
    global last_alert_time

    logger.info("[Detection] AI person detection thread started.")
    detector = init_person_detector()

    while running:
        # Grab the latest frame from memory
        with frame_cond:
            if latest_cv_frame is None:
                frame_cond.wait(timeout=0.5)
                continue
            frame = latest_cv_frame.copy()

        # Resize for faster HOG detection
        h, w = frame.shape[:2]
        target_w = 480
        scale = target_w / float(w)
        small = cv2.resize(frame, (target_w, int(h * scale)))

        boxes, weights = detector.detectMultiScale(
            small, winStride=(8, 8), padding=(4, 4), scale=1.05
        )

        now = time.time()
        if len(boxes) > 0 and (now - last_alert_time) > ALERT_COOLDOWN_SECONDS:
            best_weight = max(weights) if len(weights) > 0 else 0.85
            best_box = boxes[0].tolist()
            orig_box = [int(c / scale) for c in best_box]

            alert_payload = {
                "camera": DEVICE_UID,
                "confidence": round(float(best_weight), 2),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "bbox": orig_box,
            }
            alert_json = json.dumps(alert_payload)
            mqtt_client.publish(TOPIC_PERSON_ALERT, alert_json, qos=0)
            if SCOPED_TOPIC_ALERT:
                mqtt_client.publish(SCOPED_TOPIC_ALERT, alert_json, qos=0)
            logger.info(f"[Detection] ALERT: Person detected on {DEVICE_UID}! Confidence: {best_weight:.2f}")
            last_alert_time = now

        # Run detection at ~5 FPS to keep CPU cool while video streams at 15-20 FPS
        time.sleep(0.2)

    logger.info("[Detection] AI person detection thread stopped.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    logger.info("=" * 50)
    logger.info(" SecureHome AI Processor Service (Multi-Threaded)")
    logger.info("=" * 50)

    # 1. MQTT Client -- HiveMQ Cloud (TLS + auth)
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
        return 1

    # 2. MJPEG Relay HTTP Server (daemon thread)
    start_relay_server()

    # 3. ngrok Tunnel -- publish public HTTPS URL to MQTT
    time.sleep(1)
    start_ngrok_tunnel(mqtt_client)

    # 4. Start Camera Ingestion Thread (single connection to ESP32)
    capture_thread = threading.Thread(target=camera_capture_worker, daemon=True)
    capture_thread.start()

    # 5. Start AI Person Detection Thread (independent loop)
    detection_thread = threading.Thread(target=ai_detection_worker, args=(mqtt_client,), daemon=True)
    detection_thread.start()

    logger.info("AI Processor running. Stream and AI detection active. Press Ctrl+C to stop.")
    try:
        while running:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass

    # Cleanup
    logger.info("Shutting down AI Processor...")
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
