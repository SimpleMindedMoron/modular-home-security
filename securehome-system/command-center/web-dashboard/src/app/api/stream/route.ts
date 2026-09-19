import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) {
    return new Response('Missing stream url parameter', { status: 400 });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'ngrok-skip-browser-warning': 'true',
        'User-Agent': 'SecureHome-Edge-Relay/1.0',
      },
    });

    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=--mjpegframe',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err: unknown) {
    return new Response('Failed to connect to stream source: ' + (err as Error)?.message, { status: 502 });
  }
}
