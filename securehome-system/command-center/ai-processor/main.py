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
MIN_CONFIDENCE            = float(os.getenv('MIN_CONFIDENCE', 0.5))
RELAY_PORT                = int(os.getenv('RELAY_PORT', 8765))
NGROK_AUTHTOKEN           = os.getenv('NGROK_AUTHTOKEN', '')

# Multi-tenant Claim Token & Device UID
CLAIM_TOKEN               = os.getenv('CLAIM_TOKEN', '').strip()
DEVICE_UID                = os.getenv('DEVICE_UID', 'ESP32_CAM_01').strip()

# ===========================================================================
# 🎯 VIDEO RECORDING & AUTO-DELETION CONFIGURATION
# ===========================================================================
# 1. RECORDING_RETENTION_SECONDS: Time in seconds before recorded detection
#    videos are automatically deleted from storage.
#    👉 CHANGE THIS NUMBER TO INCREASE OR DECREASE RETENTION DURATION!
#    Example: 60 = 1 minute | 300 = 5 minutes | 3600 = 1 hour
RECORDING_RETENTION_SECONDS = int(os.getenv('RECORDING_RETENTION_SECONDS', 60))

# 2. RECORDING_DURATION_SECONDS: Duration of each video clip captured upon detection.
RECORDING_DURATION_SECONDS  = int(os.getenv('RECORDING_DURATION_SECONDS', 10))

# Directory paths for saving video clips and preview thumbnails
RECORDINGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'recordings')
THUMBNAILS_DIR = os.path.join(RECORDINGS_DIR, 'thumbnails')
os.makedirs(THUMBNAILS_DIR, exist_ok=True)

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

# Ring buffer of recent frames (pre-roll buffer before detection)
from collections import deque
frame_history      = deque(maxlen=30)
history_lock       = threading.Lock()

# Registry of active video recordings
# format: { rec_id: { 'id': str, 'filename': str, 'video_path': str, 'thumbnail_path': str, 'created_at': float, 'duration': int, 'confidence': float, 'bbox': list } }
recordings_registry = {}
recordings_lock     = threading.Lock()
is_recording_active = False


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
    client.subscribe("security/camera/settings/retention")
    logger.info("Subscribed to retention settings topic: security/camera/settings/retention")

    if SCOPED_TOPIC_DISCOVERY:
        client.subscribe(SCOPED_TOPIC_DISCOVERY)
        logger.info(f"Subscribed to scoped discovery topic: {SCOPED_TOPIC_DISCOVERY}")
        scoped_retention = f"users/{CLAIM_TOKEN}/cameras/{DEVICE_UID}/settings/retention"
        client.subscribe(scoped_retention)
        logger.info(f"Subscribed to scoped retention settings topic: {scoped_retention}")


def on_mqtt_message(client, userdata, msg):
    global RECORDING_RETENTION_SECONDS

    # 1. Dynamic Video Retention Duration Setting Update
    if msg.topic == 'security/camera/settings/retention' or msg.topic.endswith('/settings/retention'):
        try:
            payload = json.loads(msg.payload.decode('utf-8'))
            new_ret = payload.get('retention_seconds')
            if new_ret and int(new_ret) > 0:
                RECORDING_RETENTION_SECONDS = int(new_ret)
                logger.info(f"[Settings] ⏱️ Auto-delete video retention updated to {RECORDING_RETENTION_SECONDS} seconds via MQTT.")
        except Exception as err:
            logger.error(f"Error parsing retention settings update: {err}")
        return

    # 2. Camera Discovery
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
MJPEG_BOUNDARY = b"frame"


class MJPEGRelayHandler(BaseHTTPRequestHandler):
    """
    Serves the ESP32-CAM MJPEG stream at /stream by forwarding in-memory
    JPEG frames captured by the dedicated camera capture thread.
    Also serves recorded detection videos (/recordings/...) and metadata API (/api/recordings).
    """

    def log_message(self, format, *args):
        # Suppress per-request access logs to keep terminal clean
        pass

    def send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range')
        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_DELETE(self):
        clean_path = self.path.split('?')[0].rstrip('/')
        if clean_path.startswith('/api/recordings/'):
            rec_id = clean_path.replace('/api/recordings/', '').strip()
            deleted = delete_recording_by_id(rec_id)
            if deleted:
                self.send_response(200)
                self.send_cors_headers()
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "deleted", "id": rec_id}).encode('utf-8'))
            else:
                self.send_error(404, "Recording not found")
            return
        self.send_error(404)

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
            self.send_cors_headers()
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.end_headers()
            self.wfile.write(data)
            return

        # 3. Recordings List API (/api/recordings)
        if clean_path == '/api/recordings':
            now = time.time()
            query_retention = RECORDING_RETENTION_SECONDS
            if '?' in self.path:
                try:
                    import urllib.parse
                    query_components = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                    if 'retention_seconds' in query_components:
                        val = int(query_components['retention_seconds'][0])
                        if val > 0:
                            query_retention = val
                except Exception:
                    pass

            recordings_list = []
            with recordings_lock:
                for r_id, r in recordings_registry.items():
                    created_at = r.get('created_at', now)
                    age = now - created_at
                    remaining = max(0, int(query_retention - age))
                    recordings_list.append({
                        "id": r_id,
                        "device_uid": DEVICE_UID,
                        "filename": r.get('filename'),
                        "video_url": f"/recordings/{r.get('filename')}",
                        "thumbnail_url": f"/recordings/thumbnails/{r_id}.jpg",
                        "created_at": r.get('timestamp_iso'),
                        "timestamp": r.get('timestamp_iso'),
                        "duration": r.get('duration', RECORDING_DURATION_SECONDS),
                        "confidence": r.get('confidence', 0.9),
                        "remaining_seconds": remaining,
                        "expires_in": remaining,
                        "retention_seconds": query_retention
                    })

            # Sort latest first
            recordings_list.sort(key=lambda x: x.get('remaining_seconds', 0), reverse=True)
            res_data = json.dumps({"recordings": recordings_list, "retention_seconds": query_retention}).encode('utf-8')
            self.send_response(200)
            self.send_cors_headers()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(res_data)))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(res_data)
            return

        # 4. Serve Video Thumbnail (/recordings/thumbnails/<filename>)
        if clean_path.startswith('/recordings/thumbnails/'):
            filename = os.path.basename(clean_path)
            file_path = os.path.join(THUMBNAILS_DIR, filename)
            if os.path.exists(file_path):
                try:
                    with open(file_path, 'rb') as f:
                        data = f.read()
                    self.send_response(200)
                    self.send_cors_headers()
                    self.send_header('Content-Type', 'image/jpeg')
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('Cache-Control', 'public, max-age=60')
                    self.end_headers()
                    self.wfile.write(data)
                    return
                except Exception as err:
                    logger.error(f"Error serving thumbnail {filename}: {err}")
                    self.send_error(500)
                    return
            else:
                self.send_error(404, "Thumbnail not found")
                return

        # 5. Serve Video File (/recordings/<filename>)
        if clean_path.startswith('/recordings/'):
            filename = os.path.basename(clean_path)
            file_path = os.path.join(RECORDINGS_DIR, filename)
            if os.path.exists(file_path):
                try:
                    file_size = os.path.getsize(file_path)
                    with open(file_path, 'rb') as f:
                        data = f.read()
                    self.send_response(200)
                    self.send_cors_headers()
                    self.send_header('Content-Type', 'video/mp4')
                    self.send_header('Content-Length', str(file_size))
                    self.send_header('Accept-Ranges', 'bytes')
                    self.send_header('Cache-Control', 'no-cache')
                    self.end_headers()
                    self.wfile.write(data)
                    return
                except Exception as err:
                    logger.error(f"Error serving video {filename}: {err}")
                    self.send_error(500)
                    return
            else:
                self.send_error(404, "Video clip not found")
                return

        # 6. Live multipart MJPEG stream (matches /stream or /stream?...)
        if clean_path == '/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_cors_headers()
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
                            b"--frame\r\n"
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
# Video Recording & Storage Functions
# ---------------------------------------------------------------------------
def delete_recording_by_id(rec_id: str) -> bool:
    """Manually deletes a recording by its ID."""
    with recordings_lock:
        rec = recordings_registry.pop(rec_id, None)
    if not rec:
        return False
    try:
        if rec.get('video_path') and os.path.exists(rec['video_path']):
            os.remove(rec['video_path'])
        if rec.get('thumbnail_path') and os.path.exists(rec['thumbnail_path']):
            os.remove(rec['thumbnail_path'])
        logger.info(f"[Recordings] Manually deleted recording: {rec_id}")
        return True
    except Exception as err:
        logger.error(f"[Recordings] Error deleting recording {rec_id}: {err}")
        return False


def record_video_worker(rec_id: str, trigger_frame, bbox: list, confidence: float, mqtt_client):
    """
    Asynchronously records a video clip upon person detection.
    Saves pre-roll frames + live frames into an MP4 video file and saves a thumbnail image.
    Registers metadata with auto-deletion timer.
    """
    global is_recording_active
    is_recording_active = True

    try:
        timestamp_iso = datetime.now(timezone.utc).isoformat()
        video_filename = f"{rec_id}.mp4"
        thumb_filename = f"{rec_id}.jpg"
        video_path = os.path.join(RECORDINGS_DIR, video_filename)
        thumb_path = os.path.join(THUMBNAILS_DIR, thumb_filename)

        # 1. Save Thumbnail Image with Bounding Box
        thumb_img = trigger_frame.copy()
        if bbox and len(bbox) == 4:
            bx, by, bw, bh = bbox
            cv2.rectangle(thumb_img, (bx, by), (bx + bw, by + bh), (0, 0, 255), 2)
            cv2.putText(
                thumb_img,
                f"PERSON {int(confidence*100)}%",
                (bx, max(20, by - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 0, 255),
                2
            )
        cv2.imwrite(thumb_path, thumb_img, [cv2.IMWRITE_JPEG_QUALITY, 85])

        # 2. Gather Pre-Roll Frames from History
        with history_lock:
            recorded_frames = list(frame_history)

        # 3. Capture Live Frames for RECORDING_DURATION_SECONDS
        fps = 15
        total_frames_target = fps * RECORDING_DURATION_SECONDS
        frame_interval = 1.0 / fps
        start_time = time.time()

        logger.info(f"[Recording] 🎥 Started recording video clip '{video_filename}' ({RECORDING_DURATION_SECONDS}s)...")

        while (time.time() - start_time) < RECORDING_DURATION_SECONDS and running:
            with frame_cond:
                if latest_cv_frame is not None:
                    recorded_frames.append(latest_cv_frame.copy())
            time.sleep(frame_interval)

        if not recorded_frames:
            recorded_frames = [trigger_frame]

        # 4. Write Frames to MP4 Video File
        h, w = recorded_frames[0].shape[:2]
        
        # Try mp4v fourcc codec first
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(video_path, fourcc, fps, (w, h))
        
        if not out.isOpened():
            # Fallback codec
            fourcc = cv2.VideoWriter_fourcc(*'MJPG')
            out = cv2.VideoWriter(video_path, fourcc, fps, (w, h))

        for f in recorded_frames:
            if f.shape[:2] != (h, w):
                f = cv2.resize(f, (w, h))
            out.write(f)
        out.release()

        created_at = time.time()

        # 5. Register in Recordings Registry
        with recordings_lock:
            recordings_registry[rec_id] = {
                'id': rec_id,
                'filename': video_filename,
                'video_path': video_path,
                'thumbnail_path': thumb_path,
                'created_at': created_at,
                'timestamp_iso': timestamp_iso,
                'duration': RECORDING_DURATION_SECONDS,
                'confidence': confidence,
                'bbox': bbox,
                'device_uid': DEVICE_UID
            }

        logger.info(
            f"[Recording] ✅ Saved video clip '{video_filename}' ({len(recorded_frames)} frames). "
            f"Will auto-delete in {RECORDING_RETENTION_SECONDS} seconds."
        )

        # 6. Publish Video Metadata to MQTT
        video_payload = {
            "type": "video_recorded",
            "camera": DEVICE_UID,
            "recording_id": rec_id,
            "filename": video_filename,
            "video_url": f"/recordings/{video_filename}",
            "thumbnail_url": f"/recordings/thumbnails/{thumb_filename}",
            "timestamp": timestamp_iso,
            "confidence": round(float(confidence), 2),
            "duration": RECORDING_DURATION_SECONDS,
            "retention_seconds": RECORDING_RETENTION_SECONDS,
            "expires_in": RECORDING_RETENTION_SECONDS
        }
        video_json = json.dumps(video_payload)
        mqtt_client.publish(TOPIC_PERSON_ALERT, video_json, qos=0)
        if SCOPED_TOPIC_ALERT:
            mqtt_client.publish(SCOPED_TOPIC_ALERT, video_json, qos=0)

    except Exception as err:
        logger.error(f"[Recording] Error during video capture: {err}")
    finally:
        is_recording_active = False


# ===========================================================================
# ⏰ AUTO-DELETION CLEANUP WORKER THREAD
# ===========================================================================
def recording_cleanup_worker():
    """
    👉 AUTO-DELETION FEATURE:
    Dedicated background worker thread that monitors recorded videos.
    Automatically removes video files and thumbnails older than RECORDING_RETENTION_SECONDS (1 minute / 60s).
    """
    logger.info(
        f"[Cleanup] 🧹 Auto-deletion thread started. "
        f"Videos will automatically be deleted after {RECORDING_RETENTION_SECONDS} seconds."
    )

    while running:
        time.sleep(2)  # Check every 2 seconds for expired clips
        now = time.time()
        expired_ids = []

        with recordings_lock:
            for rec_id, rec in list(recordings_registry.items()):
                created_at = rec.get('created_at', now)
                age = now - created_at
                # ===================================================================
                # 👉 CHECK RETENTION DURATION HERE
                # If the video age exceeds RECORDING_RETENTION_SECONDS (60 seconds),
                # trigger automatic deletion.
                # ===================================================================
                if age >= RECORDING_RETENTION_SECONDS:
                    expired_ids.append((rec_id, rec))

        # Delete expired video and thumbnail files from disk
        for rec_id, rec in expired_ids:
            try:
                v_path = rec.get('video_path')
                t_path = rec.get('thumbnail_path')
                if v_path and os.path.exists(v_path):
                    os.remove(v_path)
                if t_path and os.path.exists(t_path):
                    os.remove(t_path)
                with recordings_lock:
                    recordings_registry.pop(rec_id, None)
                logger.info(
                    f"[Auto-Delete] 🗑️ Automatically deleted expired video: '{rec.get('filename')}' "
                    f"(Age > {RECORDING_RETENTION_SECONDS}s)."
                )
            except Exception as e:
                logger.error(f"[Auto-Delete] Failed to delete video {rec_id}: {e}")

    logger.info("[Cleanup] Auto-deletion thread stopped.")


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
    Updates in-memory latest_frame_bytes, latest_cv_frame, and frame_history ring buffer.
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

                # Add to ring buffer for video pre-roll
                with history_lock:
                    frame_history.append(frame.copy())

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
    Pulls the latest frame from memory and runs HOG detection independently.
    Triggers alert AND starts automatic video recording when a person is detected!
    """
    global last_alert_time

    logger.info("[Detection] AI person detection thread started.")
    try:
        detector = init_person_detector()
    except Exception as e:
        logger.error(f"[Detection] Failed to initialize HOG detector: {e}")
        logger.error("[Detection] Is opencv-python >= 4.x installed? Run: pip install 'opencv-python==4.10.0.84'")
        return

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
            # weights is a 2D numpy array from detectMultiScale — flatten before max()
            flat_weights = weights.flatten() if hasattr(weights, 'flatten') else weights
            best_weight = float(flat_weights.max()) if len(flat_weights) > 0 else 0.85

            # Skip low-confidence detections (applies MIN_CONFIDENCE from .env)
            if best_weight < MIN_CONFIDENCE:
                time.sleep(0.2)
                continue

            best_box = boxes[0].tolist()
            orig_box = [int(c / scale) for c in best_box]

            # Generate unique recording ID
            rec_id = f"rec_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{int(time.time()*1000)%1000}"

            alert_payload = {
                "camera": DEVICE_UID,
                "confidence": round(float(best_weight), 2),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "bbox": orig_box,
                "recording_id": rec_id,
                "retention_seconds": RECORDING_RETENTION_SECONDS
            }
            alert_json = json.dumps(alert_payload)
            mqtt_client.publish(TOPIC_PERSON_ALERT, alert_json, qos=0)
            if SCOPED_TOPIC_ALERT:
                mqtt_client.publish(SCOPED_TOPIC_ALERT, alert_json, qos=0)
            logger.info(f"[Detection] 🚨 ALERT: Person detected on {DEVICE_UID}! Confidence: {best_weight:.2f}")
            last_alert_time = now

            # 🎬 Trigger automatic video recording thread
            if not is_recording_active:
                rec_thread = threading.Thread(
                    target=record_video_worker,
                    args=(rec_id, frame, orig_box, best_weight, mqtt_client),
                    daemon=True
                )
                rec_thread.start()

        # Run detection at ~5 FPS to keep CPU cool while video streams at 15-20 FPS
        time.sleep(0.2)

    logger.info("[Detection] AI person detection thread stopped.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    logger.info("=" * 55)
    logger.info(" SecureHome AI Processor & Video Recording Service")
    logger.info(f" ⏱️ Video Retention Duration: {RECORDING_RETENTION_SECONDS} seconds (1 minute auto-delete)")
    logger.info("=" * 55)

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

    # 2. MJPEG Relay & Video Server (daemon thread)
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

    # 6. Start Automatic Video Deletion Cleanup Thread (1-minute auto-delete)
    cleanup_thread = threading.Thread(target=recording_cleanup_worker, daemon=True)
    cleanup_thread.start()

    logger.info("AI Processor running. Stream, Detection & 1-Minute Video Retention active. Press Ctrl+C to stop.")
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

