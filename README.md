# X-DL

Download videos from X (Twitter)

## Usage

```bash
# Basic usage
deno run --allow-all main.ts <tweet_url>

# Get help
deno run --allow-all main.ts -h

# Specify custom output path and filename
deno run --allow-all main.ts -o ./videos/custom-name.mp4 <tweet_url>
```

### Command Line Options

| Option         | Description                           |
| -------------- | ------------------------------------- |
| `-o, --output` | Specify the output file path and name |
| `-h, --help`   | Show help message                     |

### Examples

```bash
# Download a video with default output path (./output/[tweet_id].mp4)
deno run --allow-all main.ts https://x.com/MarcusHouse/status/1894188415442145507

# Download a video with custom output path
deno run --allow-all main.ts -o ~/Downloads/my-video.mp4 https://x.com/MarcusHouse/status/1894188415442145507
```

### Environment Variables

The script supports the following environment variables:

- `CHROME_PATH`: Path to the Chrome executable. If not set, defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- `DEBUG`: If set to any value, runs Chrome in visible mode (non-headless) for debugging purposes

Examples:

```bash
# Using custom Chrome path
CHROME_PATH="/usr/bin/google-chrome" deno run --allow-all main.ts https://x.com/2Sandui/status/1849249560096584095

# Running in debug mode with visible browser
DEBUG=true deno run --allow-all main.ts https://x.com/2Sandui/status/1849249560096584095

# Using both environment variables and custom output path
CHROME_PATH="/usr/bin/google-chrome" DEBUG=true deno run --allow-all main.ts -o ./videos/debug-video.mp4 https://x.com/2Sandui/status/1849249560096584095
```

## Requirements

- Deno runtime
- Google Chrome installed on your system
- ffmpeg installed on your system
