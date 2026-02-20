import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Multiple Piped API instances for redundancy
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.garudalinux.org',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.tokhmi.xyz',
];

interface PipedAudioStream {
  url: string;
  quality: string;
  mimeType: string;
  bitrate: number;
}

interface PipedVideoStream {
  url: string;
  quality: string;
  mimeType: string;
  videoOnly: boolean;
  codec?: string;
}

interface PipedResponse {
  title?: string;
  audioStreams: PipedAudioStream[];
  videoStreams: PipedVideoStream[];
}

async function fetchFromPiped(videoId: string): Promise<PipedResponse | null> {
  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${instance}/streams/${videoId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.audioStreams || data.videoStreams) {
          console.log(`Got streams from ${instance}`);
          return data as PipedResponse;
        }
      }
    } catch (e) {
      console.log(`Instance ${instance} failed: ${e}`);
    }
  }
  return null;
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

    const pipedData = await fetchFromPiped(videoId);

    if (!pipedData) {
      return new Response(
        JSON.stringify({ error: 'Could not retrieve video streams. The video may be unavailable.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (isAudio) {
      // Sort audio streams by bitrate descending, prefer mp4/aac
      const audioStreams = [...(pipedData.audioStreams || [])].sort((a, b) => b.bitrate - a.bitrate);
      const best = audioStreams.find(s => s.mimeType?.includes('mp4') || s.mimeType?.includes('aac'))
        || audioStreams[0];

      if (!best?.url) {
        return new Response(
          JSON.stringify({ error: 'No audio stream found for this video.' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ url: best.url, mimeType: best.mimeType, type: 'audio' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Video: first try combined streams (has audio), then video-only
    const targetQuality = quality === '2160' ? '4K' : `${quality}p`;
    const videoStreams = pipedData.videoStreams || [];

    // Combined streams (with audio) – max 720p on YouTube
    const combinedStreams = videoStreams.filter(s => !s.videoOnly && s.mimeType?.includes('mp4'));
    // Video-only streams (no audio but higher quality available)
    const videoOnlyStreams = videoStreams.filter(s => s.videoOnly && s.mimeType?.includes('mp4'));

    // Helper: pick closest quality
    const qualityOrder = ['2160p', '4K', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p'];
    const targetIdx = qualityOrder.findIndex(q => q.toLowerCase() === targetQuality.toLowerCase());

    function pickBestStream(streams: PipedVideoStream[]): PipedVideoStream | null {
      // Exact match first
      const exact = streams.find(s => s.quality?.toLowerCase() === targetQuality.toLowerCase());
      if (exact) return exact;

      // Sort by quality descending
      const sorted = [...streams].sort((a, b) => {
        const ai = qualityOrder.findIndex(q => a.quality?.toLowerCase().startsWith(q.toLowerCase().replace('4k', '2160')));
        const bi = qualityOrder.findIndex(q => b.quality?.toLowerCase().startsWith(q.toLowerCase().replace('4k', '2160')));
        return ai - bi;
      });

      // Find the closest quality at or below target
      const atOrBelow = sorted.filter(s => {
        const si = qualityOrder.findIndex(q => s.quality?.toLowerCase().startsWith(q.toLowerCase().replace('4k', '2160')));
        return si >= targetIdx;
      });

      return atOrBelow[0] || sorted[0] || null;
    }

    // Try combined first (has audio)
    let picked = pickBestStream(combinedStreams);

    // If combined stream quality is too low and user wants higher, try video-only
    if (!picked || (targetIdx < qualityOrder.indexOf('720p') && videoOnlyStreams.length > 0)) {
      const videoOnly = pickBestStream(videoOnlyStreams);
      if (videoOnly) picked = videoOnly;
    }

    if (!picked?.url) {
      return new Response(
        JSON.stringify({ error: 'No video stream found for the requested quality.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // For video-only streams, also return the best audio stream so client can inform user
    const audioForVideo = isAudio ? null : ([...(pipedData.audioStreams || [])].sort((a, b) => b.bitrate - a.bitrate)[0] || null);

    return new Response(
      JSON.stringify({
        url: picked.url,
        quality: picked.quality,
        mimeType: picked.mimeType,
        videoOnly: picked.videoOnly,
        type: 'video',
        audioUrl: picked.videoOnly ? audioForVideo?.url : undefined,
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
