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

interface Provider {
  label: string;
  buildUrl: (videoId: string) => string;
  host: string;
  normalize: (data: unknown) => VideoFormat[] | null;
}

const PROVIDERS: Provider[] = [
  {
    label: 'yt-api',
    buildUrl: (id) => `https://yt-api.p.rapidapi.com/dl?id=${id}`,
    host: 'yt-api.p.rapidapi.com',
    normalize: (data: unknown) => {
      const d = data as { formats?: VideoFormat[]; adaptiveFormats?: VideoFormat[] };
      const all = [...(d.formats || []), ...(d.adaptiveFormats || [])];
      return all.length > 0 ? all : null;
    },
  },
  {
    label: 'ytstream',
    buildUrl: (id) => `https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${id}`,
    host: 'ytstream-download-youtube-videos.p.rapidapi.com',
    normalize: (data: unknown) => {
      const d = data as { formats?: VideoFormat[]; adaptiveFormats?: VideoFormat[] };
      const all = [...(d.formats || []), ...(d.adaptiveFormats || [])];
      return all.length > 0 ? all : null;
    },
  },
  {
    label: 'yt-video-info',
    buildUrl: (id) => `https://youtube-video-download-info.p.rapidapi.com/dl?id=${id}`,
    host: 'youtube-video-download-info.p.rapidapi.com',
    normalize: (data: unknown) => {
      const d = data as { status?: string; link?: Array<Array<{ url?: string; type?: string; quality?: string }>> };
      if (d.status !== 'ok' || !Array.isArray(d.link)) return null;
      const flat = d.link.flat().map((l) => ({
        url: l.url || '',
        qualityLabel: l.quality,
        mimeType: l.type,
      })).filter(f => f.url);
      return flat.length > 0 ? flat : null;
    },
  },
];

// Per-provider cache of resolved streams. Each provider binds its links to a
// different egress IP, so a link that one provider locked may still be served
// by another. The provider whose links actually stream is remembered and
// tried first next time.
const formatCache = new Map<string, { resolved: Resolved; expires: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
let preferredProvider = 0;

async function fetchFromProvider(provider: Provider, videoId: string): Promise<VideoFormat[] | null> {
  const apiKey = Deno.env.get('RAPIDAPI_KEY');
  if (!apiKey) return null;
  try {
    const res = await fetch(provider.buildUrl(videoId), {
      headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': provider.host },
      signal: AbortSignal.timeout(20000),
    });
    console.log(`${provider.label}: HTTP ${res.status}`);
    if (!res.ok) return null;
    const data = await res.json();
    return provider.normalize(data);
  } catch (e) {
    console.log(`${provider.label}: Exception — ${e}`);
    return null;
  }
}

function hasAudioTrack(f: VideoFormat): boolean {
  if (f.hasAudio === true) return true;
  if (f.hasAudio === false) return false;
  const mime = f.mimeType || '';
  if (mime.includes('mp4a') || mime.includes('opus') || mime.includes('vorbis')) return true;
  return false;
}

function pickStream(fmts: VideoFormat[], quality: string): Picked | null {
  if (quality === 'audio') {
    const audioOnly = fmts.filter(f => f.mimeType?.startsWith('audio/')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const combined = fmts.filter(f => f.mimeType?.startsWith('video/') && hasAudioTrack(f)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const best = audioOnly[0] || combined[0];
    if (!best?.url) return null;
    return { url: best.url, mimeType: best.mimeType || 'audio/mp4', label: 'Audio', videoOnly: false };
  }

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

  if (!chosen?.url) return null;
  return {
    url: chosen.url,
    mimeType: chosen.mimeType || 'video/mp4',
    label: chosen.qualityLabel || chosen.quality || `${quality}p`,
    videoOnly: isVideoOnly,
    audioUrl: isVideoOnly ? audioStreams[0]?.url : undefined,
    audioMime: isVideoOnly ? audioStreams[0]?.mimeType : undefined,
  };
}

async function resolveFromProvider(providerIdx: number, videoId: string, quality: string): Promise<Resolved> {
  const cacheKey = `${videoId}|${quality}|${providerIdx}`;
  const cached = formatCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    console.log(`cache hit (${PROVIDERS[providerIdx].label})`);
    return cached.resolved;
  }

  const fmts = await fetchFromProvider(PROVIDERS[providerIdx], videoId);
  let resolved: Resolved;
  if (!fmts || fmts.length === 0) {
    resolved = { picked: null, error: 'No formats returned.' };
  } else {
    console.log(`${PROVIDERS[providerIdx].label}: Total formats ${fmts.length}`);
    const picked = pickStream(fmts, quality);
    resolved = picked ? { picked } : { picked: null, error: 'No suitable stream found.' };
  }
  formatCache.set(cacheKey, { resolved, expires: Date.now() + CACHE_TTL_MS });
  return resolved;
}

function pickStreamFor(quality: string, r: Resolved): { streamUrl: string; mime: string } | null {
  if (!r.picked) return null;
  const useAudio = quality === 'audio' || r.picked.audioUrl !== undefined && false;
  return { streamUrl: r.picked.url, mime: r.picked.mimeType };
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

// Stream the file to the browser with a download header, trying every
// provider until one delivers. Returns null only if all providers failed.
async function deliver(
  videoId: string,
  quality: string,
  track: string,
  title: string,
  range: string | null
): Promise<Response | null> {
  const useAudio = track === 'audio' || quality === 'audio';

  for (let i = 0; i < PROVIDERS.length; i++) {
    const idx = (preferredProvider + i) % PROVIDERS.length;
    const resolved = await resolveFromProvider(idx, videoId, quality);
    if (!resolved.picked) continue;

    const { picked } = resolved;
    const streamUrl = useAudio && quality !== 'audio' ? (picked.audioUrl || picked.url) : picked.url;
    const mime = useAudio && quality !== 'audio' ? (picked.audioMime || 'audio/mp4') : picked.mimeType;
    const suffix = quality === 'audio' || track === 'audio' ? 'Audio' : picked.label;
    const filename = safeFilename(title, suffix, mime);

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Referer': 'https://www.youtube.com/',
    };
    if (range) headers['Range'] = range;

    let upstream: Response;
    try {
      upstream = await fetch(streamUrl, { headers, redirect: 'follow' });
    } catch (e) {
      console.log(`${PROVIDERS[idx].label}: stream fetch exception — ${e}`);
      formatCache.delete(`${videoId}|${quality}|${idx}`);
      continue;
    }
    console.log(`${PROVIDERS[idx].label}: upstream HTTP ${upstream.status}`);

    if (upstream.ok || upstream.status === 206) {
      preferredProvider = idx;
      const outHeaders: Record<string, string> = {
        ...corsHeaders,
        'Content-Type': mime,
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

    // This provider's link is not fetchable — drop it from cache and try the next.
    await upstream.body?.cancel();
    formatCache.delete(`${videoId}|${quality}|${idx}`);
  }

  return null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);

    // ── GET: the browser navigates here to receive the actual file ───────
    if (req.method === 'GET') {
      const videoId = url.searchParams.get('videoId');
      const quality = url.searchParams.get('quality') || '720';
      const dl = url.searchParams.get('dl') === '1';
      const title = url.searchParams.get('title') || '';

      if (!videoId) return json({ error: 'videoId is required' }, 400);

      if (!dl) {
        const resolved = await resolveFromProvider(preferredProvider, videoId, quality);
        if (!resolved.picked) return json({ error: resolved.error || 'Could not resolve video.' }, 502);
        const { picked } = resolved;
        const suffix = quality === 'audio' ? 'Audio' : picked.label;
        return json({
          quality: picked.label,
          mimeType: picked.mimeType,
          videoOnly: picked.videoOnly,
          audioUrl: picked.audioUrl,
          filename: safeFilename(title, suffix, picked.mimeType),
          type: quality === 'audio' ? 'audio' : 'video',
        });
      }

      const resp = await deliver(
        videoId,
        quality,
        url.searchParams.get('track') || 'video',
        title,
        req.headers.get('range')
      );
      if (resp) return resp;
      return json({ error: 'The file could not be fetched right now. Please try again in a moment.' }, 502);
    }

    // ── POST: validation + metadata for the UI ───────────────────────────
    const { videoId, quality } = await req.json();
    if (!videoId) return json({ error: 'videoId is required' }, 400);

    let resolved: Resolved | null = null;
    for (let i = 0; i < PROVIDERS.length && !resolved?.picked; i++) {
      const idx = (preferredProvider + i) % PROVIDERS.length;
      const r = await resolveFromProvider(idx, videoId, quality || '720');
      if (r.picked) {
        preferredProvider = idx;
        resolved = r;
      }
    }
    if (!resolved?.picked) return json({ error: 'Could not resolve video.' }, 502);

    const { picked } = resolved;
    return json({
      quality: picked.label,
      mimeType: picked.mimeType,
      videoOnly: picked.videoOnly,
      audioUrl: picked.audioUrl,
      type: quality === 'audio' ? 'audio' : 'video',
    });
  } catch (err) {
    console.error('Download error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
