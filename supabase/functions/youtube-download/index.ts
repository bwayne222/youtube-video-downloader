import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const YT_PLAYER_API = 'https://www.youtube.com/youtubei/v1/player';
const YT_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

interface YTFormat {
  url?: string;
  signatureCipher?: string;
  mimeType: string;
  quality: string;
  qualityLabel?: string;
  bitrate?: number;
  height?: number;
  contentLength?: string;
}

interface YTPlayerResponse {
  playabilityStatus?: { status: string; reason?: string };
  streamingData?: {
    formats?: YTFormat[];
    adaptiveFormats?: YTFormat[];
    hlsManifestUrl?: string;
  };
}

async function tryYouTubeClient(
  videoId: string,
  clientName: string,
  clientVersion: string,
  clientFields: Record<string, unknown>,
  headers: Record<string, string>,
  extraBody: Record<string, unknown> = {}
): Promise<YTPlayerResponse | null> {
  try {
    const body = {
      videoId,
      context: {
        client: { clientName, clientVersion, hl: 'en', gl: 'US', ...clientFields },
        ...extraBody,
      },
    };

    const res = await fetch(`${YT_PLAYER_API}?key=${YT_API_KEY}&prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.log(`${clientName}: HTTP ${res.status}`);
      return null;
    }

    const data: YTPlayerResponse = await res.json();
    const status = data.playabilityStatus?.status;
    console.log(`${clientName}: ${status} — ${data.playabilityStatus?.reason || 'ok'}`);

    if (status !== 'OK') return null;

    const allFormats = [
      ...(data.streamingData?.formats || []),
      ...(data.streamingData?.adaptiveFormats || []),
    ];
    const direct = allFormats.filter(f => f.url && !f.signatureCipher);
    console.log(`${clientName}: ${allFormats.length} formats, ${direct.length} direct`);

    return direct.length > 0 ? data : null;
  } catch (e) {
    console.log(`${clientName} error: ${e}`);
    return null;
  }
}

async function fetchPlayerData(videoId: string): Promise<YTPlayerResponse | null> {
  // TV HTML5 embedded player — bypasses many restrictions
  const tv = await tryYouTubeClient(
    videoId,
    'TVHTML5_SIMPLY_EMBEDDED_PLAYER', '2.0',
    {},
    {
      'User-Agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1',
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/',
    },
    { thirdParty: { embedUrl: 'https://www.youtube.com/' } }
  );
  if (tv) return tv;

  // Web creator client
  const creator = await tryYouTubeClient(
    videoId,
    'WEB_CREATOR', '1.20230101',
    {},
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Origin': 'https://studio.youtube.com',
      'Referer': 'https://studio.youtube.com/',
    }
  );
  if (creator) return creator;

  // Mobile web
  const mweb = await tryYouTubeClient(
    videoId,
    'MWEB', '2.20240101',
    { userAgent: 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0 Mobile Safari/537.36' },
    {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0 Mobile Safari/537.36',
      'Origin': 'https://m.youtube.com',
      'Referer': 'https://m.youtube.com/',
    }
  );
  if (mweb) return mweb;

  return null;
}

// RapidAPI fallback — ytstream
async function fetchViaRapidAPI(videoId: string, quality: string): Promise<{ url: string; mimeType?: string; videoOnly?: boolean } | null> {
  const key = Deno.env.get('RAPIDAPI_KEY');
  if (!key) return null;

  try {
    const res = await fetch(`https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${videoId}`, {
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': 'ytstream-download-youtube-videos.p.rapidapi.com',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.log(`RapidAPI HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const isAudio = quality === 'audio';
    const formats: Array<{ url: string; qualityLabel?: string; quality?: string; mimeType?: string; hasAudio?: boolean; bitrate?: number }> = data.formats || [];

    if (isAudio) {
      // Pick audio-only
      const audio = formats
        .filter((f) => f.mimeType?.startsWith('audio/') || (!f.hasAudio && f.mimeType?.includes('audio')))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      return audio[0] ? { url: audio[0].url, mimeType: audio[0].mimeType } : null;
    }

    const targetLabel = quality === '2160' ? '2160p' : `${quality}p`;
    const videoFormats = formats.filter(f => f.mimeType?.startsWith('video/'));
    const exact = videoFormats.find(f => f.qualityLabel === targetLabel || f.quality === quality);
    const fallback = videoFormats.sort((a, b) => {
      const ah = parseInt(a.qualityLabel || '0');
      const bh = parseInt(b.qualityLabel || '0');
      return Math.abs(ah - parseInt(quality)) - Math.abs(bh - parseInt(quality));
    })[0];

    const picked = exact || fallback;
    return picked ? { url: picked.url, mimeType: picked.mimeType } : null;
  } catch (e) {
    console.log(`RapidAPI error: ${e}`);
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

    const isAudio = quality === 'audio';

    // Try YouTube internal API first
    const ytData = await fetchPlayerData(videoId);

    if (ytData?.streamingData) {
      const formats = (ytData.streamingData.formats || []).filter(f => f.url);
      const adaptive = (ytData.streamingData.adaptiveFormats || []).filter(f => f.url);

      if (isAudio) {
        const best = adaptive
          .filter(f => f.mimeType?.startsWith('audio/'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (best?.url) {
          return new Response(
            JSON.stringify({ url: best.url, mimeType: best.mimeType, type: 'audio', quality: best.quality }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      } else {
        const targetHeight = parseInt(quality);
        const combined = formats.filter(f => f.mimeType?.startsWith('video/')).sort((a, b) => (b.height || 0) - (a.height || 0));
        const videoOnly = adaptive.filter(f => f.mimeType?.startsWith('video/')).sort((a, b) => (b.height || 0) - (a.height || 0));

        let picked: YTFormat | null = null;
        let isVideoOnly = false;

        if (targetHeight > 720) {
          picked = videoOnly.find(f => f.height === targetHeight) || videoOnly.find(f => (f.height || 0) <= targetHeight) || videoOnly[0] || combined[0];
          isVideoOnly = picked ? videoOnly.includes(picked) : false;
        } else {
          picked = combined.find(f => f.height === targetHeight) || combined.find(f => (f.height || 0) <= targetHeight) || combined[0];
          isVideoOnly = false;
        }

        if (picked?.url) {
          const bestAudio = isVideoOnly
            ? adaptive.filter(f => f.mimeType?.startsWith('audio/')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
            : null;
          return new Response(
            JSON.stringify({ url: picked.url, quality: picked.qualityLabel || picked.quality, mimeType: picked.mimeType, videoOnly: isVideoOnly, type: 'video', audioUrl: bestAudio?.url || null }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }
    }

    // RapidAPI fallback
    const rapidResult = await fetchViaRapidAPI(videoId, quality);
    if (rapidResult?.url) {
      return new Response(
        JSON.stringify({ url: rapidResult.url, mimeType: rapidResult.mimeType, videoOnly: false, type: isAudio ? 'audio' : 'video' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Could not retrieve video streams. YouTube may be restricting access from this server.' }),
      { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Download error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
