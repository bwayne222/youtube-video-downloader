import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface RapidFormat {
  url: string;
  qualityLabel?: string;
  quality?: string;
  mimeType?: string;
  hasAudio?: boolean;
  bitrate?: number;
  height?: number;
  contentLength?: string;
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
    const rapidApiKey = Deno.env.get('RAPIDAPI_KEY');

    if (!rapidApiKey) {
      return new Response(
        JSON.stringify({ error: 'Service not configured. Please set up a RapidAPI key.' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Fetching streams for videoId: ${videoId}, quality: ${quality}`);

    const res = await fetch(
      `https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${videoId}`,
      {
        headers: {
          'X-RapidAPI-Key': rapidApiKey,
          'X-RapidAPI-Host': 'ytstream-download-youtube-videos.p.rapidapi.com',
        },
        signal: AbortSignal.timeout(20000),
      }
    );

    console.log(`RapidAPI status: ${res.status}`);

    if (!res.ok) {
      const body = await res.text();
      console.log(`RapidAPI error body: ${body.slice(0, 300)}`);
      const isRateLimit = res.status === 429;
      return new Response(
        JSON.stringify({
          error: isRateLimit
            ? 'Too many requests — please wait a moment and try again.'
            : `Download service error (${res.status}). Please try again.`,
        }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await res.json();
    console.log(`RapidAPI response keys: ${Object.keys(data).join(', ')}`);

    // ytstream returns { formats: [...], adaptiveFormats: [...] }
    const allFormats: RapidFormat[] = [
      ...(data.formats || []),
      ...(data.adaptiveFormats || []),
    ];

    console.log(`Total formats: ${allFormats.length}`);
    if (allFormats.length > 0) {
      console.log(`Sample format: ${JSON.stringify(allFormats[0]).slice(0, 200)}`);
    }

    if (allFormats.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No streams found for this video.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (isAudio) {
      // Get best audio-only stream
      const audioStreams = allFormats
        .filter(f => f.mimeType?.startsWith('audio/') || (f.hasAudio && !f.mimeType?.startsWith('video/')))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      // Fallback: combined streams that have audio
      const combined = allFormats
        .filter(f => f.mimeType?.startsWith('video/') && f.hasAudio !== false)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const best = audioStreams[0] || combined[0];

      if (!best?.url) {
        return new Response(
          JSON.stringify({ error: 'No audio stream found.' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ url: best.url, mimeType: best.mimeType, type: 'audio' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Video — find closest quality
    const targetHeight = parseInt(quality);
    const videoFormats = allFormats.filter(f => f.mimeType?.startsWith('video/'));

    if (videoFormats.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No video streams found.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Prefer combined (has audio), sorted by closeness to requested height
    const combined = videoFormats.filter(f => f.hasAudio !== false);
    const videoOnly = videoFormats.filter(f => f.hasAudio === false);

    function closestTo(formats: RapidFormat[], target: number): RapidFormat | null {
      if (formats.length === 0) return null;
      return formats.sort((a, b) => {
        const ah = a.height || parseInt(a.qualityLabel || '0');
        const bh = b.height || parseInt(b.qualityLabel || '0');
        // Prefer closest at or below target, then closest above
        const adiff = Math.abs(ah - target);
        const bdiff = Math.abs(bh - target);
        return adiff - bdiff;
      })[0];
    }

    let picked = closestTo(combined, targetHeight);
    let isVideoOnly = false;
    if (!picked) {
      picked = closestTo(videoOnly, targetHeight);
      isVideoOnly = !!picked;
    }

    if (!picked?.url) {
      return new Response(
        JSON.stringify({ error: 'No suitable video stream found.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const actualQuality = picked.qualityLabel || picked.quality || `${quality}p`;

    return new Response(
      JSON.stringify({
        url: picked.url,
        quality: actualQuality,
        mimeType: picked.mimeType,
        videoOnly: isVideoOnly,
        type: 'video',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Download error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
