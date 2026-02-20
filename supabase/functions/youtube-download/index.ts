import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

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
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Use yt-dlp compatible API via a reliable public endpoint
    // We use rapidapi's YouTube download service
    const rapidApiKey = Deno.env.get('RAPIDAPI_KEY');

    if (rapidApiKey) {
      // Use RapidAPI YouTube downloader
      const apiUrl = isAudio
        ? `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`
        : `https://youtube-video-download-info.p.rapidapi.com/dl?id=${videoId}`;

      const hostHeader = isAudio
        ? 'youtube-mp36.p.rapidapi.com'
        : 'youtube-video-download-info.p.rapidapi.com';

      const response = await fetch(apiUrl, {
        headers: {
          'X-RapidAPI-Key': rapidApiKey,
          'X-RapidAPI-Host': hostHeader,
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (isAudio && data.link) {
          return new Response(
            JSON.stringify({ url: data.link, filename: `audio.mp3` }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        } else if (!isAudio && data.formats) {
          const qualityMap: Record<string, string[]> = {
            '2160': ['2160p', '4K', 'uhd'],
            '1440': ['1440p', '2K', 'qhd'],
            '1080': ['1080p', 'fhd', '1080'],
            '720': ['720p', 'hd', '720'],
            '480': ['480p', 'sd', '480'],
            '360': ['360p', '360'],
            '240': ['240p', '240'],
            '144': ['144p', '144'],
          };

          const preferredLabels = qualityMap[quality] || ['720p'];
          let downloadUrl: string | null = null;

          for (const label of preferredLabels) {
            const format = data.formats.find((f: { qualityLabel?: string; url?: string }) =>
              f.qualityLabel?.toLowerCase().includes(label.toLowerCase())
            );
            if (format?.url) {
              downloadUrl = format.url;
              break;
            }
          }

          if (!downloadUrl && data.formats.length > 0) {
            downloadUrl = data.formats[0].url;
          }

          if (downloadUrl) {
            return new Response(
              JSON.stringify({ url: downloadUrl, filename: `video.mp4` }),
              { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }
        }
      }
    }

    // Fallback: use y2mate-like API (no key needed)
    const y2mateApiUrl = 'https://www.y2mate.com/mates/analyzeV2/ajax';
    const y2mateBody = new URLSearchParams({
      k_query: videoUrl,
      k_page: 'home',
      hl: 'en',
      q_auto: '0',
    });

    const y2mateRes = await fetch(y2mateApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: y2mateBody.toString(),
    });

    if (y2mateRes.ok) {
      const y2mateData = await y2mateRes.json();
      if (y2mateData.status === 'ok' && y2mateData.links) {
        const links = isAudio ? y2mateData.links.mp3 : y2mateData.links.mp4;
        if (links) {
          // Find the right quality
          const qualityKey = isAudio ? '128' : quality;
          const targetLink = links[qualityKey] || Object.values(links)[0] as { k?: string };

          if (targetLink && typeof targetLink === 'object' && 'k' in targetLink && targetLink.k) {
            // Convert via y2mate
            const convertBody = new URLSearchParams({
              type: isAudio ? 'mp3' : 'mp4',
              _id: y2mateData.vid,
              v_id: y2mateData.vid,
              ajax: '1',
              token: '',
              ftype: isAudio ? 'mp3' : 'mp4',
              fquality: qualityKey,
              k: targetLink.k as string,
            });

            const convertRes = await fetch('https://www.y2mate.com/mates/convertV2/index', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              },
              body: convertBody.toString(),
            });

            if (convertRes.ok) {
              const convertData = await convertRes.json();
              if (convertData.status === 'ok' && convertData.dlink) {
                return new Response(
                  JSON.stringify({ url: convertData.dlink }),
                  { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );
              }
            }
          }
        }
      }
    }

    // Final fallback — return a redirect URL
    return new Response(
      JSON.stringify({
        error: 'direct_download_unavailable',
        fallbackUrl: `https://www.youtube.com/watch?v=${videoId}`,
      }),
      { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Download error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
