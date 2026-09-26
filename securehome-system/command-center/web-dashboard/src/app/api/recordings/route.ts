import { NextRequest, NextResponse } from 'next/server';

// In-memory fallback cache of recordings for the dashboard web server
interface StoredRecording {
  id: string;
  device_uid: string;
  camera_name?: string;
  filename: string;
  video_url: string;
  thumbnail_url?: string;
  timestamp: string;
  created_at: number;
  duration: number;
  confidence: number;
}

let memoryRecordings: StoredRecording[] = [];

// =============================================================================
// 🎯 AUTO-DELETE DURATION CONFIGURATION (API ROUTE)
// Change this value to adjust the retention time (in seconds).
// Default: 60 seconds (1 minute).
// =============================================================================
const API_RECORDING_RETENTION_SECONDS = 60;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const deviceUid = searchParams.get('device_uid');
  const aiProcessorUrl = searchParams.get('relay_url') || process.env.AI_PROCESSOR_URL || 'http://127.0.0.1:8765';

  const now = Date.now();

  // 1. Auto-clean expired items older than 60 seconds (1 minute)
  memoryRecordings = memoryRecordings.filter((rec) => {
    const ageSeconds = (now - rec.created_at) / 1000;
    return ageSeconds < API_RECORDING_RETENTION_SECONDS;
  });

  // 2. Try proxying to AI processor if running locally or via relay
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);

    const res = await fetch(`${aiProcessorUrl}/api/recordings`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.recordings)) {
        // Merge remote AI processor recordings with memory items
        const remoteList = data.recordings.map((r: any) => ({
          ...r,
          video_url: r.video_url.startsWith('http') ? r.video_url : `${aiProcessorUrl}${r.video_url}`,
          thumbnail_url: r.thumbnail_url?.startsWith('http') ? r.thumbnail_url : `${aiProcessorUrl}${r.thumbnail_url}`,
          created_at: r.created_at ? new Date(r.created_at).getTime() : now,
        }));
        return NextResponse.json({
          recordings: remoteList,
          retention_seconds: API_RECORDING_RETENTION_SECONDS,
          source: 'ai_processor',
        });
      }
    }
  } catch (err) {
    // AI processor not reachable, fallback to memory recordings
  }

  // Filter by device if requested
  const list = deviceUid
    ? memoryRecordings.filter((r) => r.device_uid === deviceUid)
    : memoryRecordings;

  const recordingsWithRemaining = list.map((rec) => {
    const ageSeconds = (now - rec.created_at) / 1000;
    const remaining = Math.max(0, Math.ceil(API_RECORDING_RETENTION_SECONDS - ageSeconds));
    return {
      ...rec,
      remaining_seconds: remaining,
      expires_in: remaining,
      retention_seconds: API_RECORDING_RETENTION_SECONDS,
    };
  });

  return NextResponse.json({
    recordings: recordingsWithRemaining,
    retention_seconds: API_RECORDING_RETENTION_SECONDS,
    source: 'dashboard_memory',
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const now = Date.now();

    const newRecording: StoredRecording = {
      id: body.id || `rec_${Date.now()}`,
      device_uid: body.device_uid || body.camera || 'ESP32_CAM_01',
      camera_name: body.camera_name || 'Front Entrance Camera',
      filename: body.filename || `rec_${Date.now()}.mp4`,
      video_url: body.video_url || '',
      thumbnail_url: body.thumbnail_url || '',
      timestamp: body.timestamp || new Date().toISOString(),
      created_at: body.created_at || now,
      duration: body.duration || 10,
      confidence: body.confidence || 0.95,
    };

    memoryRecordings.unshift(newRecording);

    // Keep max 20 latest
    if (memoryRecordings.length > 20) {
      memoryRecordings = memoryRecordings.slice(0, 20);
    }

    return NextResponse.json({
      success: true,
      recording: newRecording,
      retention_seconds: API_RECORDING_RETENTION_SECONDS,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
  }

  memoryRecordings = memoryRecordings.filter((rec) => rec.id !== id);
  return NextResponse.json({ success: true, deleted_id: id });
}
