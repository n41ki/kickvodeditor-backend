import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Add stealth plugin to bypass Cloudflare
puppeteer.use(StealthPlugin());

// ... (other imports stay the same)

// @api-design-principles: Standard API format wrapper classes
class ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: any };

  constructor(success: boolean, data?: T, error?: { code: string; message: string; details?: any }) {
    this.success = success;
    if (data !== undefined) this.data = data;
    if (error !== undefined) this.error = error;
  }

  static success<T>(data: T) {
    return new ApiResponse<T>(true, data);
  }

  static fail(code: string, message: string, details?: any) {
    return new ApiResponse<any>(false, undefined, { code, message, details });
  }
}

// Removed ffmpeg-static usage to rely on system ffmpeg which is more stable with HLS
const app = express();

// Security and CORS configuration
app.use(cors({
  // Using an array to allow both local development and Vercel/production domains
  // Allows "*" to correctly act as a wildcard, otherwise splits the comma-separated domains
  origin: process.env.CORS_ORIGIN === '*' ? '*' : (process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*'), 
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Payload parsing
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

const CLIPS_DIR = path.join(__dirname, 'clips');
if (!fs.existsSync(CLIPS_DIR)) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

interface ClipJob {
  id: string;
  progress: number;
  status: 'processing' | 'completed' | 'error';
  url?: string;
  filename?: string;
  error?: string;
}

const clipJobs = new Map<string, ClipJob>();

// Statically serving generated clips
app.use('/clips', express.static(CLIPS_DIR));

// Healthcheck Route
app.get('/', (req, res) => {
  res.status(200).json(ApiResponse.success({ status: 'healthy', version: '1.0.0' }));
});

// @api-design-principles: Robust Error handling wrapper for async routes
const asyncHandler = (fn: Function) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

let globalBrowser: any = null;
let launchPromise: Promise<any> | null = null;

async function getBrowser() {
  if (globalBrowser) return globalBrowser;
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    const isDocker = process.env.RENDER || fs.existsSync('/.dockerenv');
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: isDocker ? '/usr/bin/google-chrome' : undefined,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });
    
    browser.on('disconnected', () => {
      globalBrowser = null;
      launchPromise = null;
    });
    
    globalBrowser = browser;
    return browser;
  })();

  return launchPromise;
}

async function fetchKickApiWithPuppeteer(url: string) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  // Optimize by blocking images, fonts, media, and third-party scripts
  await page.setRequestInterception(true);
  page.on('request', (req: any) => {
    const rt = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media', 'other'].includes(rt)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  try {
    // We only wait for 'domcontentloaded' which is much faster than 'networkidle2'
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    // Extract JSON from the page body
    const jsonText = await page.evaluate(() => {
        return document.body.innerText;
    });

    const parsedData = JSON.parse(jsonText);
    await page.close();
    return parsedData;

  } catch (err: any) {
    await page.close().catch(() => {});
    if (err.message && err.message.includes('Unexpected token')) {
       throw new Error('Cloudflare Challenge blocked the request.');
    }
    throw err;
  }
}

// API Route: Get Channel Info
app.get('/api/kick/channel/:name', asyncHandler(async (req: Request, res: Response) => {
  const channelName = req.params.name;
  
  if (!channelName || typeof channelName !== 'string') {
    return res.status(400).json(ApiResponse.fail('VALIDATION_ERROR', 'Channel name is required and must be a string.'));
  }

  try {
    const data = await fetchKickApiWithPuppeteer(`https://kick.com/api/v2/channels/${channelName}`);
    
    // Kick API usually returns an error object if not found
    if (data && data.message && data.message.includes('not found')) {
       return res.status(404).json(ApiResponse.fail('NOT_FOUND', 'Channel not found.', data));
    }

    return res.status(200).json(ApiResponse.success(data));
  } catch (error: any) {
    console.error('Error fetching channel data:', error.message);
    if (error.message.includes('Cloudflare')) {
        return res.status(403).json(ApiResponse.fail('FORBIDDEN', 'Request blocked by Cloudflare.', error.message));
    }
    return res.status(502).json(ApiResponse.fail('BAD_GATEWAY', 'Failed to communicate with Kick API.', error.message));
  }
}));

// API Route: Get Channel VODs
app.get('/api/kick/channel/:name/vods', asyncHandler(async (req: Request, res: Response) => {
    const channelName = req.params.name;
    
    if (!channelName || typeof channelName !== 'string') {
      return res.status(400).json(ApiResponse.fail('VALIDATION_ERROR', 'Channel name is required and must be a string.'));
    }
  
    try {
      // Kick's VOD API is paginated, but we'll fetch the first page for now
      const data = await fetchKickApiWithPuppeteer(`https://kick.com/api/v2/channels/${channelName}/videos`);
      
      if (data && data.message && data.message.includes('not found')) {
         return res.status(404).json(ApiResponse.fail('NOT_FOUND', 'Channel VODs not found.', data));
      }
  
      return res.status(200).json(ApiResponse.success(data));
    } catch (error: any) {
      console.error('Error fetching VOD data:', error.message);
      if (error.message.includes('Cloudflare')) {
          return res.status(403).json(ApiResponse.fail('FORBIDDEN', 'Request blocked by Cloudflare.', error.message));
      }
      return res.status(502).json(ApiResponse.fail('BAD_GATEWAY', 'Failed to communicate with Kick API.', error.message));
    }
  }));

// API Route: Get Video Info
app.get('/api/kick/video/:id', asyncHandler(async (req: Request, res: Response) => {
  const videoId = req.params.id;

  if (!videoId || typeof videoId !== 'string') {
    return res.status(400).json(ApiResponse.fail('VALIDATION_ERROR', 'Video ID is required and must be a string.'));
  }

  try {
    const data = await fetchKickApiWithPuppeteer(`https://kick.com/api/v1/video/${videoId}`);
    
    if (data && data.message && data.message.includes('not found')) {
       return res.status(404).json(ApiResponse.fail('NOT_FOUND', 'Video not found.', data));
    }

    return res.status(200).json(ApiResponse.success(data));
  } catch (error: any) {
    console.error('Error fetching video data:', error.message);
    if (error.message.includes('Cloudflare')) {
        return res.status(403).json(ApiResponse.fail('FORBIDDEN', 'Request blocked by Cloudflare.', error.message));
    }
    return res.status(502).json(ApiResponse.fail('BAD_GATEWAY', 'Failed to communicate with Kick API.', error.message));
  }
}));

// API Route: HLS Stream Proxy
// To bypass direct CORS blocks from the browser to Kick's video servers
app.get('/api/kick/stream', asyncHandler(async (req: Request, res: Response) => {
    const streamUrl = req.query.url as string;
    
    if (!streamUrl) {
       return res.status(400).send('Missing stream URL');
    }

    try {
        const response = await axios({
            method: 'GET',
            url: streamUrl,
            responseType: streamUrl.includes('.m3u8') ? 'text' : 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://kick.com',
            }
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }

        if (streamUrl.includes('.m3u8')) {
            // Rewrite inner URLs to also pass through our proxy
            let m3u8Content = response.data as string;
            const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);

            const rewritten = m3u8Content.split('\n').map(line => {
                if (line.startsWith('#') || line.trim() === '') return line;
                
                // If it's a relative URL, make it absolute
                let targetUrl = line.trim();
                if (!targetUrl.startsWith('http')) {
                    targetUrl = baseUrl + targetUrl;
                }
                
                // Wrap it in our proxy
                return `/api/kick/stream?url=${encodeURIComponent(targetUrl)}`;
            }).join('\n');

            return res.send(rewritten);
        } else {
            // For .ts or .mp4 chunks, just pipe the stream
            response.data.pipe(res);
        }

    } catch (error: any) {
       console.error('[Stream Proxy Error]', error.message);
       if (!res.headersSent) res.status(502).send('Failed to proxy stream');
    }
}));

// API Route: Generate Clip
app.post('/api/clip', asyncHandler(async (req: Request, res: Response) => {
  const { videoUrl, startTime, duration } = req.body;

  // Input Validation
  if (!videoUrl || typeof videoUrl !== 'string') {
    return res.status(400).json(ApiResponse.fail('VALIDATION_ERROR', 'videoUrl is required and must be a string.'));
  }
  if (startTime === undefined || typeof startTime !== 'number' || startTime < 0) {
    return res.status(400).json(ApiResponse.fail('VALIDATION_ERROR', 'startTime is required and must be a positive number.'));
  }
  if (!duration || typeof duration !== 'number') {
    return res.status(400).json(ApiResponse.fail('VALIDATION_ERROR', 'duration is required and must be a number.'));
  }
  // Enforcing strict clip limits
  if (duration < 5 || duration > 1200) {
    return res.status(400).json(ApiResponse.fail('VALIDATION_ERROR', 'Duration must be between 5 seconds and 20 minutes (1200 seconds).'));
  }

  const outputFilename = `clip-${Date.now()}-${Math.floor(Math.random() * 1000)}.mp4`;
  const outputPath = path.join(CLIPS_DIR, outputFilename);
  const jobId = Date.now().toString();

  console.log(`[CLIP_JOB_START] Job: ${jobId} | Filename: ${outputFilename} | Duration: ${duration}s | Start: ${startTime}s`);

  clipJobs.set(jobId, {
     id: jobId,
     progress: 0,
     status: 'processing'
  });

  // Return immediately
  res.status(200).json(ApiResponse.success({ jobId }));
  
  ffmpeg(videoUrl)
    .setStartTime(startTime)
    .setDuration(duration)
    // SIGSEGV usually happens when copying malformed/segmented HLS directly.
    // Re-encoding with veryfast preset fixes the memory segmentation fault.
    .outputOptions([
        '-c:v copy', 
        '-c:a aac',
        '-bsf:a aac_adtstoasc',
        '-movflags +faststart'
    ])
    .on('start', (commandLine) => {
        console.log(`[CLIP_JOB_SPAWN] ${jobId} -> ${commandLine}`);
    })
    .on('progress', (progress) => {
        // fluent-ffmpeg progress.percent might be undefined if total length isn't perfectly known, 
        // but often works. If undefined, we mock progress or stick to 50%.
        const job = clipJobs.get(jobId);
        if (job) {
            let p = progress.percent;
            if (p === undefined || isNaN(p)) {
                 // Try parsing timemark (e.g. 00:00:05.12)
                 if (progress.timemark) {
                    const parts = progress.timemark.split(':');
                    if (parts.length === 3) {
                       const currentSec = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
                       p = (currentSec / duration) * 100;
                    }
                 } else {
                    p = 50; 
                 }
            }
            job.progress = Math.min(Math.max(p || 50, 0), 99); 
            clipJobs.set(jobId, job);
        }
    })
    .on('end', () => {
      console.log(`[CLIP_JOB_SUCCESS] ${jobId} -> ${outputFilename}`);
      const job = clipJobs.get(jobId);
      if (job) {
          job.progress = 100;
          job.status = 'completed';
          job.url = `/clips/${outputFilename}`;
          job.filename = outputFilename;
          clipJobs.set(jobId, job);
      }
    })
    .on('error', (err: any) => {
      console.error(`[CLIP_JOB_ERROR] ${jobId}`, err.message);
      const job = clipJobs.get(jobId);
      if (job) {
          job.status = 'error';
          job.error = err.message;
          clipJobs.set(jobId, job);
      }
    })
    .save(outputPath);
}));

// API Route: Get Clip Job Status
app.get('/api/clip/:id', (req: Request, res: Response) => {
    const jobId = req.params.id;
    const job = clipJobs.get(jobId);
    
    if (!job) {
        return res.status(404).json(ApiResponse.fail('NOT_FOUND', 'Clip job not found.'));
    }

    return res.status(200).json(ApiResponse.success(job));
});

// Global Error Handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('[UNHANDLED_ERROR]', err);
  res.status(500).json(ApiResponse.fail('INTERNAL_SERVER_ERROR', 'An unexpected error occurred.', err.message));
});

// 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json(ApiResponse.fail('ROUTE_NOT_FOUND', 'The requested endpoint does not exist.'));
});

// Self-ping to keep alive on Render free tier
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
  setInterval(() => {
    axios.get(RENDER_EXTERNAL_URL).then(() => {
      console.log(`[KEEP_ALIVE] Pinged ${RENDER_EXTERNAL_URL} to prevent sleep`);
    }).catch((err) => {
      console.error(`[KEEP_ALIVE] Failed to ping ${RENDER_EXTERNAL_URL}:`, err.message);
    });
  }, 14 * 60 * 1000); // 14 minutes
}

app.listen(PORT, () => {
  console.log(`[SERVER_START] Listening on port ${PORT}`);
});
