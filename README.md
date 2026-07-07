# Local Video Cropper

Live: <https://local-video-cropper.vercel.app> · Source: <https://github.com/tap5a/local-video-cropper>

Crop, reframe and trim videos entirely in your browser — no upload, no server,
nothing leaves your device. Built on [Mediabunny](https://mediabunny.dev/) and
the WebCodecs API, so decoding/encoding uses the browser's hardware codecs and
runs at (or faster than) real time.

## Features

- **Crop mode** — drag a crop rectangle over the video; aspect presets
  16:9, 9:16, 4:3, 3:4, 1:1, 21:9, Original, or Free.
- **Fit + blur mode** — the whole video fits inside the new aspect ratio and a
  blurred, scaled-up copy of itself fills the background (the classic
  vertical-video look). Blur strength is adjustable.
- **Trim** — drag the in/out handles on the timeline to cut from the beginning
  and end. Preview playback loops within the trimmed range.
- **Fit + color mode** — video fits inside the new frame over a solid
  background color of your choice.
- **PNG overlays** — drop a transparent PNG on top of the video, scaled to
  fit the output frame, in any mode.
- **Center zoom** — in fit modes, scale the video up (0–100) so it crops in
  from the sides; 100 fills the frame completely.
- **Export to MP4** — hardware-accelerated H.264 (falls back to HEVC/VP9/AV1
  depending on the browser), quality presets, audio preserved via stream
  copy, progress bar and cancel.

## Run

```sh
npm install
npm run dev       # dev server at http://localhost:5173
npm run build     # static production build in dist/
```

The production build is a fully static site — host it anywhere (no special
headers needed; SharedArrayBuffer/COOP/COEP are not required).

## Browser support

Requires WebCodecs: Chrome/Edge 94+, Firefox 130+ (desktop), Safari 26+.
Audio is copied without re-encoding whenever possible, so trimming keeps the
original audio quality.
