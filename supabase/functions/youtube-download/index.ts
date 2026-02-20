import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
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

interface NormalizedResult {
  formats: VideoFormat[];
}

async function tryApi(
  label: string,
  url: string,
  host: string,
  apiKey: string,
  normalize: (data: unknown) => NormalizedResult | null
): Promise<NormalizedResult | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': host,
      },
      signal: AbortSignal.timeout(20000),
    });

    console.log(`${label}: HTTP ${res.status}`);

    if (res.status === 403) {
      console.log(`${label}: Not subscribed, skipping`);
      return null;
    }
    if (res.status === 429) {
      console.log(`${label}: Rate limited`);
      // Still return null so we try next API
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { videoId, quality } = await req.json();

    if (!videoId) {
      return new Response(
        JSON.stringify({ error: 'videoId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const apiKey = Deno.env.get('RAPIDAPI_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'Service not configured.' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const isAudio = quality === 'audio';
    let result: NormalizedResult | null = null;

    // ── API 1: YT-API (most popular, generous free tier) ──────────────────
    result = await tryApi(
      'yt-api',
      `https://yt-api.p.rapidapi.com/dl?id=${videoId}`,
      'yt-api.p.rapidapi.com',
      apiKey,
      (data: unknown) => {
        const d = data as { status?: string; formats?: VideoFormat[]; adaptiveFormats?: VideoFormat[] };
        // Accept any non-error status or just check formats exist
        const all = [...(d.formats || []), ...(d.adaptiveFormats || [])];
        return all.length > 0 ? { formats: all } : null;
      }
    );

    // ── API 2: YTStream Download ──────────────────────────────────────────
    if (!result) {
      result = await tryApi(
        'ytstream',
        `https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${videoId}`,
        'ytstream-download-youtube-videos.p.rapidapi.com',
        apiKey,
        (data: unknown) => {
          const d = data as { formats?: VideoFormat[]; adaptiveFormats?: VideoFormat[] };
          const all = [...(d.formats || []), ...(d.adaptiveFormats || [])];
          return all.length > 0 ? { formats: all } : null;
        }
      );
    }

    // ── API 3: YouTube Video Download Info ────────────────────────────────
    if (!result) {
      result = await tryApi(
        'yt-video-info',
        `https://youtube-video-download-info.p.rapidapi.com/dl?id=${videoId}`,
        'youtube-video-download-info.p.rapidapi.com',
        apiKey,
        (data: unknown) => {
          const d = data as { status?: string; link?: Array<Array<{ url?: string; type?: string; quality?: string }>> };
          if (d.status !== 'ok' || !Array.isArray(d.link)) return null;
          // link is array of arrays; flatten into VideoFormat[]
          const formats: VideoFormat[] = d.link.flat().map((l) => ({
            url: l.url || '',
            qualityLabel: l.quality,
            mimeType: l.type,
          })).filter(f => f.url);
          return formats.length > 0 ? { formats } : null;
        }
      );
    }

    if (!result || result.formats.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'Not subscribed to any YouTube download API. Please subscribe to "YT-API" on RapidAPI (free plan available) and try again.',
          rapidApiUrl: 'https://rapidapi.com/ytjar/api/yt-api',
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { formats } = result;
    console.log(`Total formats: ${formats.length}`);

    // ── Pick best format ──────────────────────────────────────────────────
    if (isAudio) {
      const audioOnly = formats.filter(f => f.mimeType?.startsWith('audio/')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const combined = formats.filter(f => f.mimeType?.startsWith('video/') && f.hasAudio !== false).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const best = audioOnly[0] || combined[0];

      if (!best?.url) {
        return new Response(JSON.stringify({ error: 'No audio stream found.' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ url: best.url, mimeType: best.mimeType, type: 'audio' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Video
    const targetHeight = parseInt(quality);
    const videoFormats = formats.filter(f => f.mimeType?.startsWith('video/'));

    function closest(list: VideoFormat[], target: number): VideoFormat | null {
      if (!list.length) return null;
      return list.sort((a, b) => {
        const ah = a.height || parseInt(a.qualityLabel || '0');
        const bh = b.height || parseInt(b.qualityLabel || '0');
        return Math.abs(ah - target) - Math.abs(bh - target);
      })[0];
    }

    const combined = videoFormats.filter(f => f.hasAudio !== false);
    const videoOnly = videoFormats.filter(f => f.hasAudio === false);

    let picked = closest(combined, targetHeight);
    let isVideoOnly = false;
    if (!picked) { picked = closest(videoOnly, targetHeight); isVideoOnly = true; }

    if (!picked?.url) {
      return new Response(JSON.stringify({ error: 'No suitable video stream found.' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(
      JSON.stringify({ url: picked.url, quality: picked.qualityLabel || picked.quality || `${quality}p`, mimeType: picked.mimeType, videoOnly: isVideoOnly, type: 'video' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Download error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
