import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';

// Set the path to the ffmpeg static binary
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const app = express();
// Enable CORS for all origins so the frontend can communicate with it
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Temp folder for clips. Render uses ephemeral storage, which is fine for temporary clips.
const CLIPS_DIR = path.join(__dirname, 'clips');
if (!fs.existsSync(CLIPS_DIR)) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

// Serve the clips folder statically so the frontend can download them
app.use('/clips', express.static(CLIPS_DIR));

app.get('/', (req, res) => {
  res.send('Kick VOD Editor Backend is running.');
});

// Proxy to fetch Kick channel information (bypassing CORS)
app.get('/api/kick/channel/:name', async (req: Request, res: Response) => {
  try {
    const channelName = req.params.name;
    const response = await axios.get(`https://kick.com/api/v2/channels/${channelName}`);
    res.json(response.data);
  } catch (error: any) {
    console.error('Error fetching channel data:', error.message);
    res.status(500).json({ error: 'Error fetching Kick channel', details: error.message });
  }
});

// Proxy to fetch specific Kick VOD/Video information (bypassing CORS)
app.get('/api/kick/video/:id', async (req: Request, res: Response) => {
  try {
    const videoId = req.params.id;
    const response = await axios.get(`https://kick.com/api/v1/video/${videoId}`);
    res.json(response.data);
  } catch (error: any) {
    console.error('Error fetching video data:', error.message);
    res.status(500).json({ error: 'Error fetching Kick video', details: error.message });
  }
});

// Endpoint to generate a clip using FFmpeg
app.post('/api/clip', async (req: Request, res: Response) => {
  try {
    const { videoUrl, startTime, duration } = req.body;

    if (!videoUrl || startTime === undefined || !duration) {
      return res.status(400).json({ error: 'Missing parameters: videoUrl, startTime, duration' });
    }

    if (duration < 5 || duration > 1200) {
      return res.status(400).json({ error: 'Duration must be between 5 seconds and 20 minutes (1200 seconds)' });
    }

    const outputFilename = `clip-${Date.now()}.mp4`;
    const outputPath = path.join(CLIPS_DIR, outputFilename);

    console.log(`Starting FFmpeg clip generation: ${outputFilename} (Duration: ${duration}s)`);

    // Using fluent-ffmpeg to process the m3u8 stream and extract a specific segment.
    // '-c copy' is extremely fast because it copies the streams instead of re-encoding.
    ffmpeg(videoUrl)
      .setStartTime(startTime)
      .setDuration(duration)
      .outputOptions('-c copy') 
      .on('start', (commandLine) => {
        console.log('Spawned FFmpeg with command: ' + commandLine);
      })
      .on('end', () => {
        console.log(`Finished processing: ${outputFilename}`);
        res.json({
          success: true,
          // Build absolute URL for Render if needed, but relative should be fine with the base URL setup on frontend
          clipUrl: `/clips/${outputFilename}`,
          filename: outputFilename
        });
      })
      .on('error', (err: any) => {
        console.error('FFmpeg Error:', err.message);
        res.status(500).json({ error: 'FFmpeg processing failed', details: err.message });
      })
      .save(outputPath);
      
  } catch (error: any) {
    console.error('Server error during clipping:', error.message);
    res.status(500).json({ error: 'Server error during clipping', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
