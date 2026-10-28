import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'content-length, content-range, accept-ranges, content-disposition',
};

interface VideoFormat {
  url: string;
  qualityLabel?: string;
  quality?: string;
  mimeType?: string;
  hasAudio?: boolean;
  bitrate?: number;
  height?: number;
}

interface Picked {
  url: string;
  mimeType: string;
  label: string;
  videoOnly: boolean;
  audioUrl?: string;
  audioMime?: string;
}

interface Resolved {
  picked: Picked | null;
  error?: string;
}

// In-memory cache so the browser's validation call and the file download
// that follows reuse a single upstream lookup instead of paying for two.
const formatCache = new Map<string, { resolved: Resolved; expires: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function tryApi(
  label: string,
  url: string,
  host: string,
  apiKey: string,
  normalize: (data: unknown) => VideoFormat[] | null
): Promise<VideoFormat[] | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': host,
      },
      signal: AbortSignal.timeout(20000),
    });

    console.log(`${label}: HTTP ${res.status}`);

    if (res.status === 403 || res.status === 429) {
      console.log(`${label}: Not subscribed or rate limited, skipping`);
      return null;
    }
    if (!res.ok) {
      const txt = await res.text();
      console.log(`${label}: Error — ${txt.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    console.log(`${label}: Got response, keys: ${Object.keys(data).join(', ')}`);
    return normalize(data);
  } catch (e) {
    console.log(`${label}: Exception — ${e}`);
    return null;
  }
}

async function fetchFormats(videoId: string): Promise<VideoFormat[] | null> {
  const apiKey = Deno.env.get('RAPIDAPI_KEY');
  if (!apiKey) return null;

  let formats = await tryApi(
    'yt-api',
    `https://yt-api.p.rapidapi.com/dl?id=${videoId}`,
    'yt-api.p.rapidapi.com',
    apiKey,
    (data: unknown) => {
      const d = data as { formats?: VideoFormat[]; adaptiveFormats?: VideoFormat[] };
      const all = [...(d.formats || []), ...(d.adaptiveFormats || [])];
      return all.length > 0 ? all : null;
    }
  );

  if (!formats) {
    formats = await tryApi(
      'ytstream',
      `https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${videoId}`,
      'ytstream-download-youtube-videos.p.rapidapi.com',
      apiKey,
      (data: unknown) => {
        const d = data as { formats?: VideoFormat[]; adaptiveFormats?: VideoFormat[] };
        const all = [...(d.formats || []), ...(d.adaptiveFormats || [])];
        return all.length > 0 ? all : null;
      }
    );
  }

  if (!formats) {
    formats = await tryApi(
      'yt-video-info',
      `https://youtube-video-download-info.p.rapidapi.com/dl?id=${videoId}`,
      'youtube-video-download-info.p.rapidapi.com',
      apiKey,
      (data: unknown) => {
        const d = data as { status?: string; link?: Array<Array<{ url?: string; type?: string; quality?: string }>> };
        if (d.status !== 'ok' || !Array.isArray(d.link)) return null;
        const flat = d.link.flat().map((l) => ({
          url: l.url || '',
          qualityLabel: l.quality,
          mimeType: l.type,
        })).filter(f => f.url);
        return flat.length > 0 ? flat : null;
      }
    );
  }

  return formats;
}

function hasAudioTrack(f: VideoFormat): boolean {
  if (f.hasAudio === true) return true;
  if (f.hasAudio === false) return false;
  const mime = f.mimeType || '';
  if (mime.includes('mp4a') || mime.includes('opus') || mime.includes('vorbis')) return true;
  return false;
}

async function resolveDownload(videoId: string, quality: string): Promise<Resolved> {
  const cacheKey = `${videoId}|${quality}`;
  const cached = formatCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    console.log('cache hit');
    return cached.resolved;
  }

  const isAudio = quality === 'audio';

  return (async () => {
    const key = Deno.env.get('RAPIDAPI_KEY');
    let resolved: Resolved;
    if (!key) {
      resolved = { picked: null, error: 'Service not configured.' };
    } else {
      const fmts = await fetchFormats(videoId);
      if (!fmts || fmts.length === 0) {
        resolved = { picked: null, error: 'Download service is busy right now. Please try again in a few minutes.' };
      } else {
        console.log(`Total formats: ${fmts.length}`);
        let picked: Picked | null = null;

        if (isAudio) {
          const audioOnly = fmts.filter(f => f.mimeType?.startsWith('audio/')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          const combined = fmts.filter(f => f.mimeType?.startsWith('video/') && hasAudioTrack(f)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          const best = audioOnly[0] || combined[0];
          if (best?.url) {
            picked = { url: best.url, mimeType: best.mimeType || 'audio/mp4', label: 'Audio', videoOnly: false };
          }
        } else {
          const targetHeight = parseInt(quality) || 720;
          const videoFormats = fmts.filter(f => f.mimeType?.startsWith('video/'));
          const heightOf = (f: VideoFormat) => f.height || parseInt(f.qualityLabel || '0') || 0;
          const combined = videoFormats.filter(f => hasAudioTrack(f));
          const videoOnly = videoFormats.filter(f => !hasAudioTrack(f));
          const audioStreams = fmts.filter(f => f.mimeType?.startsWith('audio/')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

          // Prefer a stream that actually reaches the requested quality:
          // 1. a combined (video+audio) stream at or above the target,
          // 2. else a video-only stream at or above it (audio offered separately),
          // 3. else the highest-quality stream available.
          const firstAtOrAbove = (list: VideoFormat[]) =>
            list.slice().sort((a, b) => heightOf(a) - heightOf(b))[0];
          const combinedUp = firstAtOrAbove(combined.filter(f => heightOf(f) >= targetHeight));
          const videoOnlyUp = firstAtOrAbove(videoOnly.filter(f => heightOf(f) >= targetHeight));

          let chosen: VideoFormat | undefined;
          let isVideoOnly = false;
          if (combinedUp) {
            chosen = combinedUp;
          } else if (videoOnlyUp) {
            chosen = videoOnlyUp;
            isVideoOnly = true;
          } else {
            const bestCombined = combined.slice().sort((a, b) => heightOf(b) - heightOf(a))[0];
            const bestVideoOnly = videoOnly.slice().sort((a, b) => heightOf(b) - heightOf(a))[0];
            if (bestVideoOnly && heightOf(bestVideoOnly) >= heightOf(bestCombined || { height: 0 } as VideoFormat)) {
              chosen = bestVideoOnly;
              isVideoOnly = true;
            } else {
              chosen = bestCombined || bestVideoOnly;
            }
          }

          if (chosen?.url) {
            let audioUrl: string | undefined;
            let audioMime: string | undefined;
            if (isVideoOnly) {
              audioUrl = audioStreams[0]?.url;
              audioMime = audioStreams[0]?.mimeType;
            }
            picked = {
              url: chosen.url,
              mimeType: chosen.mimeType || 'video/mp4',
              label: chosen.qualityLabel || chosen.quality || `${quality}p`,
              videoOnly: isVideoOnly,
              audioUrl,
              audioMime,
            };
          }
        }

        resolved = picked ? { picked } : { picked: null, error: 'No suitable stream found for this video.' };
      }
    }

    formatCache.set(cacheKey, { resolved, expires: Date.now() + CACHE_TTL_MS });
    return resolved;
  })();
}

function extFromMime(mime: string): string {
  if (mime.startsWith('audio/')) {
    if (mime.includes('mpeg')) return 'mp3';
    if (mime.includes('webm')) return 'weba';
    return 'm4a';
  }
  if (mime.includes('webm')) return 'webm';
  return 'mp4';
}

function safeFilename(title: string, suffix: string, mime: string): string {
  const clean = (title || 'video')
    .replace(/[\\/:*?"<>|\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${clean} [${suffix}].${extFromMime(mime)}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function proxyStream(streamUrl: string, filename: string, upstreamMime: string, range: string | null) {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Referer': 'https://www.youtube.com/',
  };
  if (range) headers['Range'] = range;

  const upstream = await fetch(streamUrl, { headers, redirect: 'follow' });
  console.log(`proxy: upstream HTTP ${upstream.status}`);
  if (!upstream.ok && upstream.status !== 206) {
    return json({ error: 'Could not fetch the file. Please try again.' }, 502);
  }

  const outHeaders: Record<string, string> = {
    ...corsHeaders,
    'Content-Type': upstreamMime,
    'Content-Disposition': `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };
  const len = upstream.headers.get('content-length');
  if (len) outHeaders['Content-Length'] = len;
  const cr = upstream.headers.get('content-range');
  if (cr) outHeaders['Content-Range'] = cr;

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── GET: browser navigates here to receive the actual file ───────────
    if (req.method === 'GET') {
      const p = new URL(req.url).searchParams;
      const videoId = p.get('videoId');
      const quality = p.get('quality') || '720';
      const dl = p.get('dl') === '1';
      const title = p.get('title') || '';

      if (!videoId) return json({ error: 'videoId is required' }, 400);

      const resolved = await resolveDownload(videoId, quality);
      if (!resolved.picked) return json({ error: resolved.error || 'Could not resolve video.' }, 502);

      const { picked } = resolved;
      const track = p.get('track') || 'video';
      const useAudio = track === 'audio' || quality === 'audio';
      const streamUrl = useAudio && picked.audioUrl ? picked.audioUrl : picked.url;
      const mime = useAudio && picked.audioUrl ? (picked.audioMime || 'audio/mp4') : picked.mimeType;
      const suffix = quality === 'audio' ? 'Audio' : `${picked.label}`;
      const filename = safeFilename(title, suffix, mime);

      if (!dl) {
        return json({
          url: picked.url,
          quality: picked.label,
          mimeType: picked.mimeType,
          videoOnly: picked.videoOnly,
          audioUrl: picked.audioUrl,
          filename,
          type: quality === 'audio' ? 'audio' : 'video',
        });
      }

      return await proxyStream(streamUrl, filename, mime, req.headers.get('range'));
    }

    // ── POST: validation + metadata for the UI ───────────────────────────
    const { videoId, quality } = await req.json();
    if (!videoId) return json({ error: 'videoId is required' }, 400);

    const resolved = await resolveDownload(videoId, quality || '720');
    if (!resolved.picked) return json({ error: resolved.error || 'Could not resolve video.' }, 502);

    const { picked } = resolved;
    return json({
      quality: picked.label,
      mimeType: picked.mimeType,
      videoOnly: picked.videoOnly,
      audioUrl: picked.audioUrl,
      filename: safeFilename('', picked.videoOnly ? picked.label : picked.label, picked.mimeType),
      type: quality === 'audio' ? 'audio' : 'video',
    });
  } catch (err) {
    console.error('Download error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
