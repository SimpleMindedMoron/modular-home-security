import { NextRequest, NextResponse } from 'next/server';

interface StoredSnapshot {
  id: string;
  device_uid: string;
  camera_name?: string;
  filename: string;
  snapshot_url: string;
  timestamp: string;
  created_at: number;
  confidence: number;
}

let memorySnapshots: StoredSnapshot[] = [];
const DEFAULT_RETENTION_SECONDS = 60;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const deviceUid = searchParams.get('device_uid');
  const aiProcessorUrl = process.env.AI_PROCESSOR_URL || 'http://127.0.0.1:8765';
  const requestedRetention = Number(searchParams.get('retention_seconds'));
  const retentionSeconds = Number.isFinite(requestedRetention) && requestedRetention > 0
    ? requestedRetention
    : DEFAULT_RETENTION_SECONDS;
  const now = Date.now();

  memorySnapshots = memorySnapshots.filter(
    (snapshot) => (now - snapshot.created_at) / 1000 < retentionSeconds
  );

  try {
    const response = await fetch(
      `${aiProcessorUrl}/api/recordings?retention_seconds=${retentionSeconds}`,
      { signal: AbortSignal.timeout(1200), cache: 'no-store' }
    );
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.recordings)) {
        const snapshots = data.recordings.map((snapshot: StoredSnapshot) => ({
          ...snapshot,
          snapshot_url: snapshot.snapshot_url?.startsWith('/')
            ? snapshot.snapshot_url
            : `/${snapshot.snapshot_url || ''}`,
          created_at: snapshot.created_at ? new Date(snapshot.created_at).getTime() : now,
        }));
        return NextResponse.json({ snapshots, retention_seconds: retentionSeconds });
      }
    }
  } catch {
    // The processor may not be reachable from the dashboard server.
  }

  const list = deviceUid
    ? memorySnapshots.filter((snapshot) => snapshot.device_uid === deviceUid)
    : memorySnapshots;
  const snapshots = list.map((snapshot) => {
    const remaining = Math.max(0, Math.ceil(retentionSeconds - (now - snapshot.created_at) / 1000));
    return { ...snapshot, remaining_seconds: remaining, expires_in: remaining, retention_seconds: retentionSeconds };
  });

  return NextResponse.json({ snapshots, retention_seconds: retentionSeconds, source: 'dashboard_memory' });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const now = Date.now();
    const snapshot: StoredSnapshot = {
      id: body.id || `snap_${now}`,
      device_uid: body.device_uid || body.camera || 'ESP32_CAM_01',
      camera_name: body.camera_name || 'Front Entrance Camera',
      filename: body.filename || `snap_${now}.jpg`,
      snapshot_url: body.snapshot_url || '',
      timestamp: body.timestamp || new Date(now).toISOString(),
      created_at: body.created_at || now,
      confidence: body.confidence || 0.95,
    };
    memorySnapshots.unshift(snapshot);
    memorySnapshots = memorySnapshots.slice(0, 20);
    return NextResponse.json({ success: true, snapshot, retention_seconds: DEFAULT_RETENTION_SECONDS });
  } catch (error: unknown) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });

  memorySnapshots = memorySnapshots.filter((snapshot) => snapshot.id !== id);
  const aiProcessorUrl = process.env.AI_PROCESSOR_URL || 'http://127.0.0.1:8765';
  try {
    await fetch(`${aiProcessorUrl}/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    // Processor offline or unreachable.
  }

  return NextResponse.json({ success: true, deleted_id: id });
}
