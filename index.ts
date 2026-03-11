import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
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

// Initializing ffmpeg
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const app = express();

// Security and CORS configuration
app.use(cors({
  origin: '*', // For production, this should ideally be restricted
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Payload parsing
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;

// Directory setup for clips
const CLIPS_DIR = path.join(__dirname, 'clips');
if (!fs.existsSync(CLIPS_DIR)) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

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

// Helper function to fetch Kick API endpoints via Puppeteer
async function fetchKickApiWithPuppeteer(url: string) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Extract JSON from the page body (Kick API returns raw JSON)
    const jsonText = await page.evaluate(() => {
        return document.body.innerText;
    });

    const parsedData = JSON.parse(jsonText);
    await browser.close();
    return parsedData;

  } catch (err: any) {
    await browser.close();
    if (err.message.includes('Unexpected token')) {
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

  console.log(`[CLIP_JOB_START] Filename: ${outputFilename} | Duration: ${duration}s | Start: ${startTime}s`);

  // We do not await this, we listen for events. Since we want an HTTP response we wait for 'end'
  // For long processing >30s on Serverless/Render, WebSockets or polling is recommended.
  // Because 'fluent-ffmpeg' allows '-c copy', it's extremely fast and usually completes within HTTP timeout.
  
  ffmpeg(videoUrl)
    .setStartTime(startTime)
    .setDuration(duration)
    .outputOptions('-c copy')
    .on('start', (commandLine) => {
        console.log(`[CLIP_JOB_SPAWN] ${commandLine}`);
    })
    .on('end', () => {
      console.log(`[CLIP_JOB_SUCCESS] ${outputFilename}`);
      return res.status(200).json(ApiResponse.success({
        clipUrl: `/clips/${outputFilename}`,
        filename: outputFilename,
        expiresIn: 'Ephemeral storage, clip may be deleted on next deploy/restart.',
      }));
    })
    .on('error', (err: any) => {
      console.error(`[CLIP_JOB_ERROR]`, err.message);
      
      // If headers are not sent yet, return 500
      if (!res.headersSent) {
          return res.status(500).json(ApiResponse.fail('PROCESSING_ERROR', 'An error occurred while generating the clip.', err.message));
      }
    })
    .save(outputPath);
}));

// Global Error Handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('[UNHANDLED_ERROR]', err);
  res.status(500).json(ApiResponse.fail('INTERNAL_SERVER_ERROR', 'An unexpected error occurred.', err.message));
});

// 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json(ApiResponse.fail('ROUTE_NOT_FOUND', 'The requested endpoint does not exist.'));
});

app.listen(PORT, () => {
  console.log(`[SERVER_START] Listening on port ${PORT}`);
});
