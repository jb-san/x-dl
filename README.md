# X-DL

A simple command-line tool to download videos from X (formerly Twitter) posts.

### Features

- Download high-quality videos from X/Twitter posts
- Automatically select the best quality or choose your preferred quality level
- Support for both direct MP4 downloads and m3u8 (HLS) streams
- Progress bar with download speed information
- Support for Ctrl+C cancellation (graceful shutdown)
- Multiple download modes (fast hybrid or full browser)
- Configurable timeouts and output paths

### Requirements

- [Deno](https://deno.land/) (for running the script)
- [FFmpeg](https://ffmpeg.org/) (for processing m3u8 playlists)
- Chrome/Chromium browser (optional: can be specified via environment variable)

### Installation

1. Install Deno: https://deno.land/#installation
2. Install FFmpeg: https://ffmpeg.org/download.html
3. Clone this repository or download the `main.ts` file

### Usage

Basic usage:

```bash
deno run --allow-all main.ts <tweet_url>
```

#### Command Line Options

| Option                    | Description                                                               |
| ------------------------- | ------------------------------------------------------------------------- |
| `-o, --output <path>`     | Specify the output file path and name                                     |
| `-t, --timeout <seconds>` | Set timeout in seconds for page loading (default: 60)                     |
| `-q, --quality <quality>` | Set video quality (highest, high, medium, low, lowest) (default: highest) |
| `-f, --fast`              | Enable fast download mode using hybrid approach (default: true)           |
| `--no-fast`               | Disable fast mode and use full browser-based download                     |
| `-h, --help`              | Show help message                                                         |

#### Environment Variables

| Variable      | Description                                     |
| ------------- | ----------------------------------------------- |
| `CHROME_PATH` | Path to Chrome executable                       |
| `DEBUG`       | Set to any value to run browser in visible mode |

### Download Modes

X-DL offers two download modes:

1. **Fast Hybrid Mode (Default)**: Uses a browser to quickly find video URLs, then closes it and performs direct downloads. This provides better reliability than API-only methods while being more efficient than keeping the browser open during the entire download.

2. **Full Browser Mode**: Keeps the browser open throughout the entire download process. This is the most compatible mode but uses more resources. Enable with `--no-fast`.

### Examples

Download with default settings (highest quality):

```bash
deno run --allow-all main.ts https://x.com/user/status/123456789
```

Specify output file:

```bash
deno run --allow-all main.ts -o ./videos/my-video.mp4 https://x.com/user/status/123456789
```

Set a longer timeout for slow connections:

```bash
deno run --allow-all main.ts -t 120 https://x.com/user/status/123456789
```

Select medium quality (for bandwidth savings):

```bash
deno run --allow-all main.ts -q medium https://x.com/user/status/123456789
```

Download with full browser mode (no fast mode):

```bash
deno run --allow-all main.ts --no-fast https://x.com/user/status/123456789
```

Use visible browser for debugging:

```bash
DEBUG=1 deno run --allow-all main.ts https://x.com/user/status/123456789
```

### Cancellation

You can safely cancel a download at any time by pressing Ctrl+C. The script will clean up any browser instances or FFmpeg processes before exiting.

### License

MIT
