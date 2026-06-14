import { Config } from '@remotion/cli/config';

// Reel-format: 9:16, 30fps, H.264 — wat IG verwacht voor Reels-uploads.
Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.setConcurrency(null); // auto: cpu_count - 1
