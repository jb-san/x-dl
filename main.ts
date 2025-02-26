import { parse } from "https://deno.land/std@0.210.0/flags/mod.ts";
import { ensureDir } from "https://deno.land/std@0.210.0/fs/ensure_dir.ts";
import { dirname } from "https://deno.land/std@0.210.0/path/mod.ts";
import puppeteer from "npm:puppeteer@21.6.1";

// Progress bar utilities
function createProgressBar(width = 40) {
  return {
    start: (title: string) => {
      Deno.stdout.writeSync(new TextEncoder().encode(`${title} `));
    },
    update: (ratio: number, speed = "", eta = "") => {
      const percent = Math.floor(ratio * 100);
      const completed = Math.floor(width * ratio);
      const remaining = width - completed;

      const bar = "█".repeat(completed) + "░".repeat(remaining);
      let status = `${percent}%`;

      if (speed) {
        status += ` | ${speed}`;
      }

      if (eta) {
        status += ` | ETA: ${eta}`;
      }

      // Clear line and reset cursor
      Deno.stdout.writeSync(new TextEncoder().encode("\r\x1b[K"));
      Deno.stdout.writeSync(new TextEncoder().encode(`[${bar}] ${status}`));
    },
    finish: (message: string) => {
      // Clear line and reset cursor
      Deno.stdout.writeSync(new TextEncoder().encode("\r\x1b[K"));
      Deno.stdout.writeSync(new TextEncoder().encode(`✓ ${message}\n`));
    },
  };
}

// Format byte size to human-readable format
function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return (
    parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i]
  );
}

// Format time (seconds) to human-readable format
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) {
    return "calculating...";
  }

  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);

  if (mins < 60) {
    return `${mins}m ${secs}s`;
  }

  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;

  return `${hours}h ${remainingMins}m ${secs}s`;
}

// Calculate download speed
function calculateSpeed(bytesDownloaded: number, elapsedMs: number): string {
  if (elapsedMs === 0) return "0 B/s";

  const bytesPerSecond = (bytesDownloaded / elapsedMs) * 1000;
  return `${formatBytes(bytesPerSecond)}/s`;
}

// Global browser reference to allow cleanup on SIGINT
let browserInstance: puppeteer.Browser | null = null;
// Reference to any running ffmpeg process
let ffmpegProcess: Deno.ChildProcess | null = null;

// Handle SIGINT (Ctrl+C) to gracefully close browser
Deno.addSignalListener("SIGINT", async () => {
  console.log("\nInterrupted. Cleaning up and exiting...");

  // Close browser if it exists
  if (browserInstance) {
    try {
      console.log("Closing browser...");
      await browserInstance.close();
      console.log("Browser closed");
    } catch (e) {
      console.error("Error closing browser:", e);
    }
  }

  // Kill ffmpeg process if it exists
  if (ffmpegProcess) {
    try {
      console.log("Stopping ffmpeg process...");
      ffmpegProcess.kill("SIGTERM");
      console.log("ffmpeg process stopped");
    } catch (e) {
      console.error("Error stopping ffmpeg process:", e);
    }
  }

  // Exit with non-zero code to indicate interruption
  Deno.exit(130); // Standard exit code for SIGINT
});

// Parse command line arguments
const parsedArgs = parse(Deno.args, {
  string: ["o", "t", "q", "f"],
  alias: {
    o: "output",
    h: "help",
    t: "timeout",
    q: "quality",
    f: "fast",
  },
  boolean: ["help", "fast"],
  default: {
    t: "60", // Default timeout in seconds
    q: "highest", // Default quality
    f: true, // Fast mode enabled by default
  },
});

// Function to display help message
function showHelp() {
  console.log(`
X-DL - Download videos from X (Twitter)

Usage:
  deno run --allow-all main.ts [options] <tweet_url>

Options:
  -o, --output <path>     Specify the output file path and name
  -t, --timeout <seconds> Set timeout in seconds for page loading (default: 60)
  -q, --quality <quality> Set video quality (highest, high, medium, low) (default: highest)
  -f, --fast              Enable fast download mode using direct API access (default: true)
  --no-fast               Disable fast mode and use browser-based download
  -h, --help              Show this help message

Environment Variables:
  CHROME_PATH             Path to Chrome executable
  DEBUG                   Set to any value to run browser in visible mode

Examples:
  deno run --allow-all main.ts https://x.com/user/status/123456789
  deno run --allow-all main.ts -o ./videos/my-video.mp4 https://x.com/user/status/123456789
  deno run --allow-all main.ts -t 120 https://x.com/user/status/123456789
  deno run --allow-all main.ts -q medium https://x.com/user/status/123456789
  deno run --allow-all main.ts --no-fast https://x.com/user/status/123456789
  `);
  Deno.exit(0);
}

// Show help if requested or no URL provided
if (parsedArgs.help || parsedArgs._.length === 0) {
  showHelp();
}

// Function to extract tweet ID from URL
function extractTweetId(url: string): string {
  try {
    return url.split("/status/")[1].split(/[?#]/)[0];
  } catch (e) {
    console.error("Could not parse tweet ID from URL");
    return new Date().getTime().toString();
  }
}

// Function to fetch and parse m3u8 playlist
async function fetchM3u8Playlist(playlistUrl: string): Promise<string[]> {
  console.log(`Fetching M3U8 playlist: ${playlistUrl}`);

  try {
    const response = await fetch(playlistUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        Referer: "https://twitter.com/",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch M3U8 playlist: ${response.status} ${response.statusText}`
      );
    }

    const playlist = await response.text();
    const lines = playlist.split("\n");
    const segmentUrls: string[] = [];

    // Extract segment URLs from playlist
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith("#")) {
        // It's a segment URL
        if (trimmedLine.startsWith("http")) {
          segmentUrls.push(trimmedLine);
        } else {
          // Relative URL - construct full URL
          const baseUrl = playlistUrl.substring(
            0,
            playlistUrl.lastIndexOf("/") + 1
          );
          segmentUrls.push(baseUrl + trimmedLine);
        }
      }
    }

    return segmentUrls;
  } catch (error) {
    console.error(`Error fetching M3U8 playlist: ${error}`);
    return [];
  }
}

// Function to try fetching Twitter video API directly (fast path)
async function tryFastVideoDownload(
  tweetId: string,
  outputPath: string,
  qualitySetting: string
): Promise<boolean> {
  if (!parsedArgs.fast) {
    console.log("Fast mode is disabled, using browser-based download");
    return false;
  }

  console.log("Attempting fast download using browser for URL detection...");

  // Get Chrome path from environment variable or use default
  const chromePath =
    Deno.env.get("CHROME_PATH") ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  // Get debug mode from environment variable - if DEBUG is set to any value, run in non-headless mode
  const isDebugMode = Deno.env.has("DEBUG");
  const headless = !isDebugMode ? "new" : false;

  console.log(`Chrome path: ${chromePath}`);
  console.log(`Headless mode: ${headless}`);

  // Launch browser just to find video URLs
  const browser = await puppeteer.launch({
    headless: headless,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=1280,800",
    ],
    executablePath: chromePath,
  });

  // Store the browser instance for potential cleanup on SIGINT
  browserInstance = browser;

  try {
    const page = await browser.newPage();

    // Set a more realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Set extra HTTP headers to appear more like a regular browser
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      Connection: "keep-alive",
    });

    // Track all media URLs
    const mediaUrls: {
      m3u8Playlists: Set<string>;
      mp4Files: Set<string>;
      videoUrls: Set<string>;
      audioUrls: Set<string>;
    } = {
      m3u8Playlists: new Set(),
      mp4Files: new Set(),
      videoUrls: new Set(),
      audioUrls: new Set(),
    };

    // Monitor network requests
    await page.setRequestInterception(true);

    page.on("request", (request) => {
      request.continue();
    });

    page.on("response", async (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";

      // Look for media content
      if (
        url.includes(".m3u8") ||
        contentType.includes("application/x-mpegURL")
      ) {
        console.log("Found m3u8 playlist:", url);
        mediaUrls.m3u8Playlists.add(url);

        // Categorize as video or audio
        if (url.includes("video")) {
          mediaUrls.videoUrls.add(url);
        } else if (url.includes("audio")) {
          mediaUrls.audioUrls.add(url);
        }
      } else if (url.includes(".mp4") || contentType.includes("video/mp4")) {
        console.log("Found MP4 file:", url);
        mediaUrls.mp4Files.add(url);
      }

      // Try to extract URLs from API responses
      if (
        (url.includes("api.twitter.com") ||
          url.includes("api.x.com") ||
          url.includes("video.twimg") ||
          url.includes("ton/tweet/")) &&
        (contentType.includes("application/json") ||
          contentType.includes("video") ||
          contentType === "")
      ) {
        try {
          // For video content or empty content type, we can't parse as JSON
          if (contentType.includes("video") || contentType === "") {
            if (url.includes(".mp4")) {
              console.log("Found direct video URL:", url);
              mediaUrls.mp4Files.add(url);
            }
            return;
          }

          const data = await response.json();
          extractVideoUrls(data, mediaUrls);
        } catch (e) {
          // Ignore JSON parsing errors
        }
      }
    });

    // Modify URL to ensure we get the full post view
    let targetUrl = `https://x.com/${tweetId}`;
    if (tweetId.includes("/")) {
      // It's a full URL
      targetUrl = tweetId;
    } else {
      targetUrl = `https://x.com/i/status/${tweetId}`;
    }

    if (!targetUrl.includes("?ref=")) {
      targetUrl = `${targetUrl}?ref=twsrc%5Etfw`;
    }

    // Navigate to the X post
    console.log("Loading page to find media URLs:", targetUrl);
    await page.goto(targetUrl, {
      waitUntil: "networkidle2",
      timeout: parseInt(parsedArgs.timeout as string, 10) * 1000,
    });
    console.log("Page loaded");

    // Wait a bit to capture all network requests
    console.log("Waiting to capture all media URLs...");
    await new Promise((resolve) => setTimeout(resolve, 8000));

    // Try to extract video sources from page
    const videoSrcs = await page.evaluate(() => {
      // @ts-ignore - Access to DOM in browser context
      const videos = Array.from(document.querySelectorAll("video"));
      return (
        videos
          // @ts-ignore - Access to video.src in browser context
          .map((video) => video.src)
          .filter((src) => src && src.length > 0)
      );
    });

    if (videoSrcs.length > 0) {
      console.log("Found video sources directly from HTML:", videoSrcs);
      videoSrcs.forEach((src) => {
        if (src.includes(".mp4")) {
          mediaUrls.mp4Files.add(src);
        } else if (src.includes(".m3u8")) {
          mediaUrls.m3u8Playlists.add(src);
        }
      });
    }

    // Close the browser as we now have the URLs
    console.log("Closing browser after finding video URLs");
    await browser.close();
    browserInstance = null;

    // Log all captured URLs for debugging
    console.log("Captured media URLs:");
    console.log("MP4 files:", Array.from(mediaUrls.mp4Files));
    console.log("M3U8 playlists:", Array.from(mediaUrls.m3u8Playlists));
    console.log("Video URLs:", Array.from(mediaUrls.videoUrls));
    console.log("Audio URLs:", Array.from(mediaUrls.audioUrls));

    // Determine best video/audio URLs
    let videoUrl = "";
    let audioUrl = "";

    // First check for mp4 files (direct download is more reliable)
    if (mediaUrls.mp4Files.size > 0) {
      // Sort MP4 files by presumed quality
      const mp4Urls = Array.from(mediaUrls.mp4Files);

      // Filter out segmented MP4 files (.m4s) which aren't complete MP4 files
      const fullMp4s = mp4Urls.filter((url) => !url.endsWith(".m4s"));

      if (fullMp4s.length > 0) {
        // Function to get quality score for a URL
        const getQualityScore = (url: string) => {
          if (url.includes("1280x720") || url.includes("720p")) return 700;
          if (
            url.includes("852x480") ||
            url.includes("848x480") ||
            url.includes("480p")
          )
            return 500;
          if (url.includes("640x360") || url.includes("360p")) return 300;
          if (
            url.includes("320x180") ||
            url.includes("240p") ||
            url.includes("180p")
          )
            return 100;
          // Check for x-bit-rate parameter
          const bitrateMatch = url.match(/x-bit-rate=(\d+)/);
          if (bitrateMatch) {
            return parseInt(bitrateMatch[1], 10);
          }
          // Higher resolution indicators in URL usually mean better quality
          return url.length;
        };

        // Sort URLs by quality
        const sortedUrls = fullMp4s.sort((a, b) => {
          return getQualityScore(b) - getQualityScore(a);
        });

        // Select based on quality parameter
        if (qualitySetting === "lowest" && sortedUrls.length > 0) {
          videoUrl = sortedUrls[sortedUrls.length - 1];
          console.log("Using lowest quality MP4 file:", videoUrl);
        } else if (qualitySetting === "low" && sortedUrls.length > 1) {
          // Use the second lowest or lowest if only two qualities
          const index = Math.max(0, sortedUrls.length - 2);
          videoUrl = sortedUrls[index];
          console.log("Using low quality MP4 file:", videoUrl);
        } else if (qualitySetting === "medium" && sortedUrls.length > 2) {
          // Use middle quality
          const index = Math.floor(sortedUrls.length / 2);
          videoUrl = sortedUrls[index];
          console.log("Using medium quality MP4 file:", videoUrl);
        } else if (qualitySetting === "high" && sortedUrls.length > 1) {
          // Use second highest or highest if only two qualities
          videoUrl = sortedUrls[Math.min(1, sortedUrls.length - 1)];
          console.log("Using high quality MP4 file:", videoUrl);
        } else {
          // Default to highest quality (or any quality if specific option not available)
          videoUrl = sortedUrls[0];
          console.log("Using highest quality MP4 file:", videoUrl);
        }
      }
    }

    // Then check for m3u8 playlists if no MP4
    if (
      !videoUrl &&
      (mediaUrls.videoUrls.size > 0 || mediaUrls.m3u8Playlists.size > 0)
    ) {
      // Prefer video-specific m3u8 URLs first
      if (mediaUrls.videoUrls.size > 0) {
        videoUrl = Array.from(mediaUrls.videoUrls)[0];
        console.log("Using video stream URL:", videoUrl);
      } else {
        videoUrl = Array.from(mediaUrls.m3u8Playlists)[0];
        console.log("Using m3u8 playlist as video URL:", videoUrl);
      }

      if (mediaUrls.audioUrls.size > 0) {
        audioUrl = Array.from(mediaUrls.audioUrls)[0];
        console.log("Found separate audio URL:", audioUrl);
      }
    }

    if (!videoUrl) {
      console.log(
        "Could not find any video URLs from browser, falling back to full browser download"
      );
      return false;
    }

    // Download and process
    if (videoUrl.endsWith(".m3u8")) {
      // Handle m3u8 content
      console.log("Processing m3u8 content...");

      let ffmpegArgs: string[];

      if (audioUrl && audioUrl !== videoUrl) {
        // With separate audio track
        console.log("Using separate audio track:", audioUrl);
        ffmpegArgs = [
          "-i",
          videoUrl,
          "-i",
          audioUrl,
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-f",
          "mp4", // Explicitly specify format
          outputPath,
        ];
      } else {
        // Just use ffmpeg directly on the m3u8 URL
        console.log("Processing video stream");
        ffmpegArgs = [
          "-i",
          videoUrl,
          "-c",
          "copy",
          "-bsf:a",
          "aac_adtstoasc",
          "-f",
          "mp4", // Explicitly specify format
          outputPath,
        ];
      }

      const ffmpegSuccess = await executeFFmpeg(ffmpegArgs, outputPath);

      if (!ffmpegSuccess) {
        throw new Error("Failed to process video with ffmpeg");
      }

      return true;
    } else {
      // Direct MP4 download
      console.log("Downloading MP4 file...");
      await downloadFile(videoUrl, outputPath);
      return true;
    }
  } catch (error) {
    console.error("Error in browser-based fast download:", error);
    console.log("Falling back to full browser download method");

    // Close the browser if it's still open
    if (browserInstance) {
      await browserInstance.close();
      browserInstance = null;
    }

    return false;
  }
}

// Function to download a file directly with progress bar
async function downloadFile(url: string, outputPath: string): Promise<void> {
  const progress = createProgressBar(40);
  progress.start("Downloading video");

  try {
    // Get video size with a HEAD request if possible
    let totalBytes = 0;
    try {
      const headResponse = await fetch(url, {
        method: "HEAD",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://twitter.com/",
        },
      });

      if (headResponse.ok) {
        const contentLength = headResponse.headers.get("content-length");
        if (contentLength) {
          totalBytes = parseInt(contentLength, 10);
        }
      }
    } catch (error) {
      // If HEAD request fails, continue without total size
      console.log(
        "Couldn't determine file size, downloading without progress percentage"
      );
    }

    // Start the actual download
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://twitter.com/",
        Accept: "video/webm,video/mp4,video/*,*/*",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download file: ${response.status} ${response.statusText}`
      );
    }

    // If we still don't have content length, try to get it from the GET response
    if (totalBytes === 0) {
      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        totalBytes = parseInt(contentLength, 10);
      }
    }

    // Set up file for writing
    const file = await Deno.open(outputPath, {
      write: true,
      create: true,
      truncate: true,
    });

    try {
      if (!response.body) {
        throw new Error("Response body is null");
      }

      const reader = response.body.getReader();
      let bytesReceived = 0;
      let startTime = Date.now();
      let lastSpeedUpdate = startTime;
      let lastBytesForSpeed = 0;
      let currentSpeed = "0 B/s";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Write chunk to file
        await file.write(value);

        // Update progress
        bytesReceived += value.length;
        const now = Date.now();
        const elapsedSeconds = (now - startTime) / 1000;

        // Update speed every 500ms for smoother display
        if (now - lastSpeedUpdate > 500) {
          const chunkBytes = bytesReceived - lastBytesForSpeed;
          const chunkTime = now - lastSpeedUpdate;
          currentSpeed = calculateSpeed(chunkBytes, chunkTime);

          lastSpeedUpdate = now;
          lastBytesForSpeed = bytesReceived;
        }

        // Calculate ETA
        let eta = "calculating...";
        if (totalBytes > 0 && bytesReceived > 0 && elapsedSeconds > 1) {
          const remainingBytes = totalBytes - bytesReceived;
          const bytesPerSecond = bytesReceived / elapsedSeconds;
          if (bytesPerSecond > 0) {
            const remainingSeconds = remainingBytes / bytesPerSecond;
            eta = formatTime(remainingSeconds);
          }
        }

        // Update progress bar
        if (totalBytes > 0) {
          const ratio = bytesReceived / totalBytes;
          progress.update(ratio, currentSpeed, eta);
        } else {
          // If we don't know the total size, show downloaded size instead of percentage
          progress.update(
            0.5,
            `${formatBytes(bytesReceived)} | ${currentSpeed}`
          );
        }
      }

      progress.finish(
        `Downloaded ${formatBytes(bytesReceived)} to ${outputPath}`
      );
    } finally {
      file.close();
    }
  } catch (error: unknown) {
    progress.finish(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}

// Execute FFmpeg with progress display
async function executeFFmpeg(
  args: string[],
  outputPath: string
): Promise<boolean> {
  console.log("Processing video with FFmpeg...");

  const progress = createProgressBar(40);
  progress.start("Processing video");

  try {
    // Create FFmpeg process
    const command = new Deno.Command("ffmpeg", {
      args: [...args],
      stdout: "piped",
      stderr: "piped",
    });

    const process = command.spawn();
    ffmpegProcess = process;

    // Track time for speed calculation
    const startTime = Date.now();

    // FFmpeg writes progress to stderr
    const decoder = new TextDecoder();

    // Variables to track progress
    let duration = 0;
    let currentTime = 0;
    let speed = "0x";
    let progressRatio = 0;
    let lastProgressUpdate = Date.now();

    // Process stderr for progress information
    const processStderr = async () => {
      if (!process.stderr) return;

      // Convert ReadableStream to async iterable
      const reader = process.stderr.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value);

          // Extract duration if we don't have it yet
          if (duration === 0) {
            const durationMatch = text.match(
              /Duration: (\d+):(\d+):(\d+\.\d+)/
            );
            if (durationMatch) {
              const hours = parseInt(durationMatch[1], 10);
              const minutes = parseInt(durationMatch[2], 10);
              const seconds = parseFloat(durationMatch[3]);
              duration = hours * 3600 + minutes * 60 + seconds;
            }
          }

          // Extract current time
          const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
          if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            const seconds = parseFloat(timeMatch[3]);
            currentTime = hours * 3600 + minutes * 60 + seconds;

            // Update progress if we know the duration
            if (duration > 0) {
              progressRatio = Math.min(currentTime / duration, 1.0);
            }
          }

          // Extract speed
          const speedMatch = text.match(/speed=(\S+)x/);
          if (speedMatch) {
            speed = `${speedMatch[1]}x`;
          }

          // Update progress bar (limit updates to every 100ms for performance)
          const now = Date.now();
          if (now - lastProgressUpdate > 100) {
            if (duration > 0) {
              const eta =
                progressRatio < 1
                  ? formatTime(
                      (duration - currentTime) / parseFloat(speed) || 0
                    )
                  : "0s";
              progress.update(progressRatio, `Speed: ${speed}`, eta);
            } else {
              // If we don't know duration, just show a moving bar
              progressRatio = (progressRatio + 0.01) % 1;
              progress.update(progressRatio, `Speed: ${speed}`);
            }
            lastProgressUpdate = now;
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    // Process stderr in the background
    processStderr();

    // Wait for FFmpeg to complete
    const { code } = await process.status;
    ffmpegProcess = null;

    // Calculate total time
    const elapsedTime = (Date.now() - startTime) / 1000;

    if (code === 0) {
      progress.finish(
        `Processed video to ${outputPath} in ${formatTime(elapsedTime)}`
      );
      return true;
    } else {
      // Get all stderr output for error details
      progress.finish(`FFmpeg failed with code ${code}`);
      return false;
    }
  } catch (error: unknown) {
    progress.finish(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

// Function to download a video from X (Twitter)
async function downloadXVideo(url: string, outputPath: string): Promise<void> {
  console.log(`Processing URL: ${url}`);

  // Parse timeout setting (in seconds) and convert to milliseconds
  const timeoutSec = parseInt(parsedArgs.timeout as string, 10);
  const navigationTimeoutMs = timeoutSec * 1000;
  const selectorTimeoutMs = Math.max(
    5000,
    Math.floor(navigationTimeoutMs / 12)
  ); // Proportionally set selector timeout
  const networkWaitTimeMs = Math.max(
    10000,
    Math.floor(navigationTimeoutMs / 3)
  ); // Proportionally set network wait time

  // Get quality setting
  const quality = (parsedArgs.quality as string).toLowerCase();
  console.log(`Quality setting: ${quality}`);

  console.log(
    `Timeouts: navigation=${timeoutSec}s, selector=${
      selectorTimeoutMs / 1000
    }s, network wait=${networkWaitTimeMs / 1000}s`
  );

  // Create directory for output file if it doesn't exist
  await ensureDir(dirname(outputPath));
  await ensureDir("./temp"); // Temp directory for intermediate files

  // Get Chrome path from environment variable or use default
  const chromePath =
    Deno.env.get("CHROME_PATH") ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  // Get debug mode from environment variable - if DEBUG is set to any value, run in non-headless mode
  const isDebugMode = Deno.env.has("DEBUG");
  const headless = !isDebugMode ? "new" : false;

  console.log(`Chrome path: ${chromePath}`);
  console.log(`Headless mode: ${headless}`);
  console.log(`Output will be saved to: ${outputPath}`);

  // Launch browser
  browserInstance = await puppeteer.launch({
    headless: headless, // Use headless mode setting from environment
    defaultViewport: null, // Use default viewport size
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=1280,800",
    ],
    executablePath: chromePath, // Use Chrome path from environment variable
  });

  try {
    const page = await browserInstance.newPage();

    // Set a more realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Set extra HTTP headers to appear more like a regular browser
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      Connection: "keep-alive",
    });

    // Track all media URLs
    const mediaUrls: {
      m3u8Playlists: Set<string>;
      mp4Files: Set<string>;
      videoUrls: Set<string>;
      audioUrls: Set<string>;
    } = {
      m3u8Playlists: new Set(),
      mp4Files: new Set(),
      videoUrls: new Set(),
      audioUrls: new Set(),
    };

    // Monitor network requests
    await page.setRequestInterception(true);

    page.on("request", (request) => {
      request.continue();
    });

    page.on("response", async (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      // Look for media content
      if (
        url.includes(".m3u8") ||
        contentType.includes("application/x-mpegURL")
      ) {
        console.log("Found m3u8 playlist:", url);
        mediaUrls.m3u8Playlists.add(url);

        // Categorize as video or audio
        if (url.includes("video")) {
          mediaUrls.videoUrls.add(url);
        } else if (url.includes("audio")) {
          mediaUrls.audioUrls.add(url);
        }
      } else if (url.includes(".mp4") || contentType.includes("video/mp4")) {
        console.log("Found MP4 file:", url);
        mediaUrls.mp4Files.add(url);
      }

      // Try to extract URLs from API responses
      if (
        (url.includes("api.twitter.com") ||
          url.includes("api.x.com") ||
          url.includes("video.twimg") ||
          url.includes("ton/tweet/")) &&
        (contentType.includes("application/json") ||
          contentType.includes("video") ||
          contentType === "")
      ) {
        try {
          // For video content or empty content type, we can't parse as JSON
          if (contentType.includes("video") || contentType === "") {
            if (url.includes(".mp4")) {
              console.log("Found direct video URL:", url);
              mediaUrls.mp4Files.add(url);
            }
            return;
          }

          const data = await response.json();
          extractVideoUrls(data, mediaUrls);
        } catch (e) {
          // Ignore JSON parsing errors
        }
      }
    });

    // Modify URL to ensure we get the full post view
    let targetUrl = url;
    if (!url.includes("?ref=")) {
      targetUrl = `${url}?ref=twsrc%5Etfw`;
    }

    // Navigate to the X post
    console.log("Loading page:", targetUrl);
    await page.goto(targetUrl, {
      waitUntil: "networkidle2",
      timeout: navigationTimeoutMs,
    });
    console.log("Page loaded");

    // Try different selectors for videos
    const videoSelectors = [
      "video",
      '[data-testid="videoPlayer"]',
      '[role="button"][tabindex="0"] video',
      '[data-testid="videoComponent"]',
      '[data-testid="media-container"] video',
      ".r-1awozwy video",
      "article video",
    ];

    let videoFound = false;
    for (const selector of videoSelectors) {
      try {
        console.log(`Trying to find video with selector: ${selector}`);
        const videoElement = await page.waitForSelector(selector, {
          timeout: selectorTimeoutMs,
        });
        if (videoElement) {
          console.log(`Video element found with selector: ${selector}`);
          videoFound = true;

          // Click on the video to ensure it loads
          await page.evaluate((selector) => {
            // @ts-ignore - Access to DOM in browser context
            const element = document.querySelector(selector);
            if (element) {
              // @ts-ignore
              element.click();
            }
          }, selector);

          break;
        }
      } catch (e) {
        console.log(`No video found with selector: ${selector}`);
      }
    }

    if (!videoFound) {
      console.log(
        "No video element found directly, continuing with network analysis"
      );

      // Try to scrape src from video elements directly using page.evaluate
      const videoSrcs = await page.evaluate(() => {
        // @ts-ignore - Access to DOM in browser context
        const videos = Array.from(document.querySelectorAll("video"));
        return (
          videos
            // @ts-ignore - Access to video.src in browser context
            .map((video) => video.src)
            .filter((src) => src && src.length > 0)
        );
      });

      if (videoSrcs.length > 0) {
        console.log("Found video sources directly from HTML:", videoSrcs);
        videoSrcs.forEach((src) => {
          if (src.includes(".mp4")) {
            mediaUrls.mp4Files.add(src);
          } else if (src.includes(".m3u8")) {
            mediaUrls.m3u8Playlists.add(src);
          }
        });
      }
    }

    // Wait longer to capture all network requests
    console.log(
      `Waiting to capture all media URLs (${networkWaitTimeMs / 1000}s)...`
    );
    await new Promise((resolve) => setTimeout(resolve, networkWaitTimeMs));

    // If we haven't found any videos yet, try scrolling and interacting with the page
    if (mediaUrls.mp4Files.size === 0 && mediaUrls.m3u8Playlists.size === 0) {
      console.log(
        "No media URLs found yet, trying to interact with the page..."
      );

      // Sometimes clicking on the tweet area can reveal the video player
      try {
        await page.click("article");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } catch (e) {
        console.log("Could not click on article");
      }

      // Try clicking on media container
      try {
        await page.click('[data-testid="media-container"]');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } catch (e) {
        console.log("Could not click on media container");
      }
    }

    // Log all captured URLs for debugging
    console.log("Captured media URLs:");
    console.log("MP4 files:", Array.from(mediaUrls.mp4Files));
    console.log("M3U8 playlists:", Array.from(mediaUrls.m3u8Playlists));
    console.log("Video URLs:", Array.from(mediaUrls.videoUrls));
    console.log("Audio URLs:", Array.from(mediaUrls.audioUrls));

    // Check if we have video.twimg.com URLs in network logs
    console.log("Checking for video.twimg.com URLs in page resources...");
    const resources = await page.evaluate(() => {
      // @ts-ignore
      return (
        performance
          .getEntriesByType("resource")
          .filter(
            (resource) =>
              // @ts-ignore
              resource.name.includes("video.twimg.com") ||
              // @ts-ignore
              resource.name.includes(".mp4") ||
              // @ts-ignore
              resource.name.includes("video/")
          )
          // @ts-ignore
          .map((resource) => resource.name)
      );
    });

    console.log("Found these video-related resources:", resources);
    resources.forEach((url) => {
      if (url.includes(".mp4")) {
        mediaUrls.mp4Files.add(url);
      } else if (url.includes(".m3u8")) {
        mediaUrls.m3u8Playlists.add(url);
      }
    });

    // Determine best video/audio URLs
    let videoUrl = "";
    let audioUrl = "";

    // First check for mp4 files (direct download is more reliable)
    if (mediaUrls.mp4Files.size > 0) {
      // Sort MP4 files by presumed quality
      const mp4Urls = Array.from(mediaUrls.mp4Files);

      // Filter out segmented MP4 files (.m4s) which aren't complete MP4 files
      const fullMp4s = mp4Urls.filter((url) => !url.endsWith(".m4s"));

      if (fullMp4s.length > 0) {
        // Function to get quality score for a URL
        const getQualityScore = (url: string) => {
          if (url.includes("1280x720") || url.includes("720p")) return 700;
          if (
            url.includes("852x480") ||
            url.includes("848x480") ||
            url.includes("480p")
          )
            return 500;
          if (url.includes("640x360") || url.includes("360p")) return 300;
          if (
            url.includes("320x180") ||
            url.includes("240p") ||
            url.includes("180p")
          )
            return 100;
          // Check for x-bit-rate parameter
          const bitrateMatch = url.match(/x-bit-rate=(\d+)/);
          if (bitrateMatch) {
            return parseInt(bitrateMatch[1], 10);
          }
          // Higher resolution indicators in URL usually mean better quality
          return url.length;
        };

        // Sort URLs by quality
        const sortedUrls = fullMp4s.sort((a, b) => {
          return getQualityScore(b) - getQualityScore(a);
        });

        // Select based on quality parameter
        if (quality === "lowest" && sortedUrls.length > 0) {
          videoUrl = sortedUrls[sortedUrls.length - 1];
          console.log("Using lowest quality MP4 file:", videoUrl);
        } else if (quality === "low" && sortedUrls.length > 1) {
          // Use the second lowest or lowest if only two qualities
          const index = Math.max(0, sortedUrls.length - 2);
          videoUrl = sortedUrls[index];
          console.log("Using low quality MP4 file:", videoUrl);
        } else if (quality === "medium" && sortedUrls.length > 2) {
          // Use middle quality
          const index = Math.floor(sortedUrls.length / 2);
          videoUrl = sortedUrls[index];
          console.log("Using medium quality MP4 file:", videoUrl);
        } else if (quality === "high" && sortedUrls.length > 1) {
          // Use second highest or highest if only two qualities
          videoUrl = sortedUrls[Math.min(1, sortedUrls.length - 1)];
          console.log("Using high quality MP4 file:", videoUrl);
        } else {
          // Default to highest quality (or any quality if specific option not available)
          videoUrl = sortedUrls[0];
          console.log("Using highest quality MP4 file:", videoUrl);
        }
      } else {
        console.log(
          "Only found segmented MP4 files (.m4s), trying m3u8 playlists instead"
        );
        // If we only have segmented files, fall back to m3u8 playlists
        if (mediaUrls.m3u8Playlists.size > 0) {
          videoUrl = Array.from(mediaUrls.m3u8Playlists)[0];
          console.log("Using m3u8 playlist instead:", videoUrl);
        }
      }
    }
    // Then check for m3u8 playlists if no MP4
    else if (mediaUrls.videoUrls.size > 0) {
      videoUrl = Array.from(mediaUrls.videoUrls)[0];
      console.log("Found video URL:", videoUrl);
    } else if (mediaUrls.m3u8Playlists.size > 0) {
      videoUrl = Array.from(mediaUrls.m3u8Playlists)[0];
      console.log("Using m3u8 playlist as video URL:", videoUrl);
    }

    if (mediaUrls.audioUrls.size > 0) {
      audioUrl = Array.from(mediaUrls.audioUrls)[0];
      console.log("Found audio URL:", audioUrl);
    }

    if (!videoUrl) {
      // As a last resort, try to get the og:video meta tag
      try {
        const ogVideo = await page.evaluate(() => {
          // @ts-ignore
          const metaTag = document.querySelector(
            'meta[property="og:video:url"], meta[property="og:video"]'
          );
          // @ts-ignore
          return metaTag ? metaTag.getAttribute("content") : null;
        });

        if (ogVideo) {
          console.log("Found video URL from og:video meta tag:", ogVideo);
          videoUrl = ogVideo;
          if (ogVideo.includes(".mp4")) {
            mediaUrls.mp4Files.add(ogVideo);
          }
        }
      } catch (e) {
        console.log("Error getting og:video meta tag:", e);
      }
    }

    if (!videoUrl) {
      throw new Error(
        "Could not find any video URLs. Please check if the tweet actually contains a video."
      );
    }

    console.log("Selected video URL:", videoUrl);

    // Download and process
    if (videoUrl.endsWith(".m3u8")) {
      // Handle m3u8 content
      console.log("Processing m3u8 content...");

      let ffmpegArgs: string[];

      if (audioUrl && audioUrl !== videoUrl) {
        // With separate audio track
        console.log("Using separate audio track:", audioUrl);
        ffmpegArgs = [
          "-i",
          videoUrl,
          "-i",
          audioUrl,
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-f",
          "mp4", // Explicitly specify format
          outputPath,
        ];
      } else {
        // Just use ffmpeg directly on the m3u8 URL
        console.log("Processing video stream");
        ffmpegArgs = [
          "-i",
          videoUrl,
          "-c",
          "copy",
          "-bsf:a",
          "aac_adtstoasc",
          "-f",
          "mp4", // Explicitly specify format
          outputPath,
        ];
      }

      const ffmpegSuccess = await executeFFmpeg(ffmpegArgs, outputPath);

      if (!ffmpegSuccess) {
        throw new Error("Failed to process video with ffmpeg");
      }
    } else {
      // Direct MP4 download
      console.log("Downloading MP4 file...");

      // Use custom fetch with proper headers to avoid blocking
      const response = await fetch(videoUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://twitter.com/",
          Accept: "video/webm,video/mp4,video/*,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "sec-ch-ua":
            '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
          "sec-ch-ua-platform": '"macOS"',
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to download video: ${response.status} ${response.statusText}`
        );
      }

      const videoData = new Uint8Array(await response.arrayBuffer());

      await Deno.writeFile(outputPath, videoData);
    }

    // Verify file exists and has reasonable size
    try {
      const fileInfo = await Deno.stat(outputPath);
      console.log(`Video saved to ${outputPath}, size: ${fileInfo.size} bytes`);
    } catch (error) {
      console.error("Error verifying output file:", error);
      throw error;
    }
  } catch (error) {
    console.error("Error:", error);
    throw error; // Re-throw to make sure it's caught in main
  } finally {
    if (browserInstance) {
      await browserInstance.close();
      browserInstance = null;
      console.log("Browser closed");
    }
  }
}

// Helper function to extract video URLs from API responses
function extractVideoUrls(data: any, mediaUrls: any): void {
  if (!data || typeof data !== "object") return;

  // Look for Twitter video variants in API responses
  if (data.video_info?.variants) {
    for (const variant of data.video_info.variants) {
      if (variant.url) {
        console.log("Found API video URL:", variant.url);
        if (variant.url.includes(".m3u8")) {
          mediaUrls.m3u8Playlists.add(variant.url);
        } else if (variant.url.includes(".mp4")) {
          mediaUrls.mp4Files.add(variant.url);
        }
      }
    }
  }

  // X/Twitter also sometimes stores videos in media_entities
  if (data.extended_entities?.media) {
    for (const media of data.extended_entities.media) {
      if (media.video_info?.variants) {
        for (const variant of media.video_info.variants) {
          if (variant.url) {
            console.log(
              "Found API video URL in extended entities:",
              variant.url
            );
            if (variant.url.includes(".m3u8")) {
              mediaUrls.m3u8Playlists.add(variant.url);
            } else if (variant.url.includes(".mp4")) {
              mediaUrls.mp4Files.add(variant.url);
            }
          }
        }
      }
    }
  }

  // Check for direct video URLs in any string properties
  if (typeof data === "object") {
    for (const key in data) {
      if (typeof data[key] === "string") {
        const value = data[key];
        if (
          (value.includes("video.twimg.com") ||
            value.includes("amp.twimg.com")) &&
          (value.includes(".mp4") || value.includes(".m3u8"))
        ) {
          console.log(`Found video URL in ${key}:`, value);
          if (value.includes(".mp4")) {
            mediaUrls.mp4Files.add(value);
          } else if (value.includes(".m3u8")) {
            mediaUrls.m3u8Playlists.add(value);
          }
        }
      }
    }
  }

  // Recursively search through the object
  if (Array.isArray(data)) {
    for (const item of data) {
      extractVideoUrls(item, mediaUrls);
    }
  } else {
    for (const key in data) {
      extractVideoUrls(data[key], mediaUrls);
    }
  }
}

// Main function
async function main() {
  // Get URL from command line arguments (the last non-option argument)
  const url = parsedArgs._[0] as string;

  // Validate URL
  if (!url.includes("x.com") && !url.includes("twitter.com")) {
    console.error("URL does not appear to be from X/Twitter");
    Deno.exit(1);
  }

  // Determine output path
  let outputPath: string;

  if (parsedArgs.output) {
    // User specified output path
    outputPath = parsedArgs.output;

    // Create the containing directory if it doesn't exist
    await ensureDir(dirname(outputPath));
  } else {
    // Default output path based on tweet ID
    await ensureDir("./output");

    // Generate output filename based on tweet ID
    const tweetId = extractTweetId(url);
    outputPath = `./output/${tweetId}.mp4`;
  }

  try {
    // Try the fast path first (direct API access)
    const tweetId = extractTweetId(url);
    const quality = (parsedArgs.quality as string).toLowerCase();

    const fastSuccess = await tryFastVideoDownload(
      tweetId,
      outputPath,
      quality
    );

    if (!fastSuccess) {
      // Fall back to the browser-based approach
      console.log("Using browser-based download as fallback...");
      await downloadXVideo(url, outputPath);
    }

    console.log(`Video successfully downloaded to ${outputPath}`);
  } catch (error) {
    console.error("Failed to download video:", error);

    // Close browser if it's still open
    if (browserInstance) {
      await browserInstance.close();
      browserInstance = null;
    }

    Deno.exit(1);
  }
}

// Run main function
main();
