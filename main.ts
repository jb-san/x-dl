import { parse } from "https://deno.land/std@0.210.0/flags/mod.ts";
import { ensureDir } from "https://deno.land/std@0.210.0/fs/ensure_dir.ts";
import { dirname } from "https://deno.land/std@0.210.0/path/mod.ts";
import puppeteer from "npm:puppeteer@21.6.1";

// Parse command line arguments
const parsedArgs = parse(Deno.args, {
  string: ["o"],
  alias: {
    o: "output",
    h: "help",
  },
  boolean: ["help"],
});

// Function to display help message
function showHelp() {
  console.log(`
X-DL - Download videos from X (Twitter)

Usage:
  deno run --allow-all main.ts [options] <tweet_url>

Options:
  -o, --output <path>     Specify the output file path and name
  -h, --help              Show this help message

Environment Variables:
  CHROME_PATH             Path to Chrome executable
  DEBUG                   Set to any value to run browser in visible mode

Examples:
  deno run --allow-all main.ts https://x.com/user/status/123456789
  deno run --allow-all main.ts -o ./videos/my-video.mp4 https://x.com/user/status/123456789
  `);
  Deno.exit(0);
}

// Show help if requested or no URL provided
if (parsedArgs.help || parsedArgs._.length === 0) {
  showHelp();
}

// Function to download a video from X (Twitter)
async function downloadXVideo(url: string, outputPath: string): Promise<void> {
  console.log(`Processing URL: ${url}`);

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
  const browser = await puppeteer.launch({
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
    let targetUrl = url;
    if (!url.includes("?ref=")) {
      targetUrl = `${url}?ref=twsrc%5Etfw`;
    }

    // Navigate to the X post
    console.log("Loading page:", targetUrl);
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
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
          timeout: 5000,
        });
        if (videoElement) {
          console.log(`Video element found with selector: ${selector}`);
          videoFound = true;

          // Click on the video to ensure it loads
          await page.evaluate((selector) => {
            // @ts-ignore - Ignore TS errors about document
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
        // @ts-ignore
        const videos = Array.from(document.querySelectorAll("video"));
        // @ts-ignore
        return videos
          .map((video) => video.src)
          .filter((src) => src && src.length > 0);
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
    console.log("Waiting to capture all media URLs...");
    await new Promise((resolve) => setTimeout(resolve, 20000));

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
        // Sort by bitrate indicators in URL when available
        videoUrl = fullMp4s.sort((a, b) => {
          const getQualityScore = (url: string) => {
            if (url.includes("1280x720")) return 700;
            if (url.includes("852x480") || url.includes("848x480")) return 500;
            if (url.includes("640x360")) return 300;
            if (url.includes("320x180")) return 100;
            // Check for x-bit-rate parameter
            const bitrateMatch = url.match(/x-bit-rate=(\d+)/);
            if (bitrateMatch) {
              return parseInt(bitrateMatch[1], 10);
            }
            // Higher resolution indicators in URL usually mean better quality
            return url.length;
          };
          return getQualityScore(b) - getQualityScore(a);
        })[0];
        console.log("Using highest quality MP4 file:", videoUrl);
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
        console.log("Using single m3u8 stream with embedded audio");
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

      console.log("Running FFmpeg with args:", ffmpegArgs.join(" "));

      const command = new Deno.Command("ffmpeg", {
        args: ffmpegArgs,
      });

      const { code, stderr } = await command.output();

      if (code !== 0) {
        console.error("ffmpeg error:", new TextDecoder().decode(stderr));
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
    await browser.close();
    console.log("Browser closed");
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
    let tweetId;
    try {
      tweetId = url.split("/status/")[1].split(/[?#]/)[0];
    } catch (e) {
      console.error("Could not parse tweet ID from URL");
      tweetId = new Date().getTime().toString();
    }

    outputPath = `./output/${tweetId}.mp4`;
  }

  try {
    await downloadXVideo(url, outputPath);
    console.log(`Video successfully downloaded to ${outputPath}`);
  } catch (error) {
    console.error("Failed to download video:", error);
    Deno.exit(1);
  }
}

// Run main function
main();
