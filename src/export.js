import {
  Input,
  Output,
  Conversion,
  BlobSource,
  BufferTarget,
  Mp4OutputFormat,
  ALL_FORMATS,
  getFirstEncodableVideoCodec,
  QUALITY_MEDIUM,
  QUALITY_HIGH,
  QUALITY_VERY_HIGH,
} from 'mediabunny';

export { Input, BlobSource, ALL_FORMATS };

const QUALITIES = {
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  very_high: QUALITY_VERY_HIGH,
};

const evenDim = (n) => Math.max(2, 2 * Math.round(n / 2));

const supportsCanvasFilter = (() => {
  try {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d');
    ctx.filter = 'blur(2px)';
    return ctx.filter !== 'none' && ctx.filter !== '';
  } catch {
    return false;
  }
})();

// Geometry for fit modes: background covers the output box, foreground fits
// inside it. Background is overscanned slightly so blur doesn't reveal
// dark edges.
export function fitLayout(srcW, srcH, outW, outH) {
  const cover = Math.max(outW / srcW, outH / srcH) * 1.1;
  const fit = Math.min(outW / srcW, outH / srcH);
  return {
    bg: {
      dx: (outW - srcW * cover) / 2,
      dy: (outH - srcH * cover) / 2,
      dw: srcW * cover,
      dh: srcH * cover,
    },
    fg: {
      dx: (outW - srcW * fit) / 2,
      dy: (outH - srcH * fit) / 2,
      dw: srcW * fit,
      dh: srcH * fit,
    },
  };
}

export function drawOverlayContain(ctx, bitmap, outW, outH) {
  const fit = Math.min(outW / bitmap.width, outH / bitmap.height);
  const dw = bitmap.width * fit;
  const dh = bitmap.height * fit;
  ctx.drawImage(bitmap, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
}

/**
 * Draws a fit-mode composite frame onto ctx.
 * bg: { type: 'blur', blurPx } | { type: 'color', color }
 * drawFrame(dx, dy, dw, dh, targetCtx?) draws the current video frame.
 */
export function drawComposite(ctx, outW, outH, srcW, srcH, bg, drawFrame, fallbackCanvas, overlayBitmap) {
  const layout = fitLayout(srcW, srcH, outW, outH);
  ctx.clearRect(0, 0, outW, outH);

  if (bg.type === 'color') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, outW, outH);
  } else if (bg.blurPx <= 0) {
    const { bg: b } = layout;
    drawFrame(b.dx, b.dy, b.dw, b.dh);
  } else if (supportsCanvasFilter) {
    ctx.filter = `blur(${bg.blurPx}px)`;
    const { bg: b } = layout;
    drawFrame(b.dx, b.dy, b.dw, b.dh);
    ctx.filter = 'none';
  } else {
    // Fallback for browsers without ctx.filter: draw tiny, then upscale with
    // smoothing — a cheap approximation of a gaussian blur.
    const shrink = Math.max(2, Math.min(32, bg.blurPx / 2));
    const tw = Math.max(2, Math.round(outW / shrink));
    const th = Math.max(2, Math.round(outH / shrink));
    const tmp = fallbackCanvas;
    tmp.width = tw;
    tmp.height = th;
    const tctx = tmp.getContext('2d');
    const { bg: b } = layout;
    tctx.save();
    tctx.scale(tw / outW, th / outH);
    drawFrame(b.dx, b.dy, b.dw, b.dh, tctx);
    tctx.restore();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, outW, outH);
  }

  const { fg } = layout;
  drawFrame(fg.dx, fg.dy, fg.dw, fg.dh);

  if (overlayBitmap) drawOverlayContain(ctx, overlayBitmap, outW, outH);
}

// Output size for fit modes: short side matches the source's short side,
// long side follows the target aspect ratio.
export function fitOutputDims(srcW, srcH, aspect) {
  const shortSide = Math.min(srcW, srcH);
  let outW, outH;
  if (aspect >= 1) {
    outH = shortSide;
    outW = shortSide * aspect;
  } else {
    outW = shortSide;
    outH = shortSide / aspect;
  }
  return { outW: evenDim(outW), outH: evenDim(outH) };
}

/**
 * Runs the export. Returns { promise, cancel }.
 * opts: { file, mode ('crop'|'blur'|'color'), crop {x,y,w,h}, srcW, srcH,
 *         aspect (number|null), trimStart, trimEnd, duration, blurAmount,
 *         bgColor, quality, overlay (ImageBitmap|null) }
 */
export function exportVideo(opts, onProgress) {
  let conversion = null;
  let canceled = false;

  const promise = (async () => {
    const {
      file, mode, crop, srcW, srcH, aspect,
      trimStart, trimEnd, duration, blurAmount, bgColor, quality, overlay,
    } = opts;

    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

    let outW, outH;
    let videoOptions;

    if (mode === 'crop') {
      const left = Math.round(Math.max(0, crop.x));
      const top = Math.round(Math.max(0, crop.y));
      const width = Math.round(Math.min(crop.w, srcW - left));
      const height = Math.round(Math.min(crop.h, srcH - top));
      outW = evenDim(width);
      outH = evenDim(height);
      videoOptions = {
        crop: { left, top, width, height },
        width: outW,
        height: outH,
        fit: 'fill',
      };
      if (overlay) {
        // sample arrives already cropped+resized; draw it, then the overlay
        const canvas = new OffscreenCanvas(outW, outH);
        const ctx = canvas.getContext('2d');
        videoOptions.process = (sample) => {
          ctx.clearRect(0, 0, outW, outH);
          sample.draw(ctx, 0, 0, outW, outH);
          drawOverlayContain(ctx, overlay, outW, outH);
          return canvas;
        };
        videoOptions.processedWidth = outW;
        videoOptions.processedHeight = outH;
      }
    } else {
      const targetAspect = aspect ?? srcW / srcH;
      ({ outW, outH } = fitOutputDims(srcW, srcH, targetAspect));
      const canvas = new OffscreenCanvas(outW, outH);
      const ctx = canvas.getContext('2d');
      const fallbackCanvas = new OffscreenCanvas(2, 2);
      const bg = mode === 'blur'
        ? { type: 'blur', blurPx: (blurAmount * Math.max(outW, outH)) / 1080 }
        : { type: 'color', color: bgColor || '#000000' };
      videoOptions = {
        process: (sample) => {
          const draw = (dx, dy, dw, dh, targetCtx) =>
            sample.draw(targetCtx || ctx, dx, dy, dw, dh);
          drawComposite(
            ctx, outW, outH,
            sample.displayWidth, sample.displayHeight,
            bg, draw, fallbackCanvas, overlay
          );
          return canvas;
        },
        processedWidth: outW,
        processedHeight: outH,
      };
    }

    const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], {
      width: outW,
      height: outH,
    });
    if (!codec) {
      throw new Error('This browser cannot encode video at these dimensions (WebCodecs unavailable?).');
    }
    videoOptions.codec = codec;
    videoOptions.bitrate = QUALITIES[quality] ?? QUALITY_HIGH;

    const conversionOptions = {
      input,
      output,
      video: videoOptions,
      showWarnings: false,
    };

    const eps = 0.01;
    if (trimStart > eps || trimEnd < duration - eps) {
      conversionOptions.trim = { start: trimStart, end: trimEnd };
    }

    conversion = await Conversion.init(conversionOptions);
    if (canceled) throw new Error('Export canceled.');

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks
        .map((t) => `${t.track.type}: ${t.reason}`)
        .join('; ');
      throw new Error(`Cannot convert this file (${reasons || 'no usable tracks'}).`);
    }

    conversion.onProgress = (p) => onProgress?.(p);
    await conversion.execute();

    const buffer = output.target.buffer;
    const blob = new Blob([buffer], { type: 'video/mp4' });
    return { blob, outW, outH, codec };
  })();

  return {
    promise,
    cancel: () => {
      canceled = true;
      conversion?.cancel();
    },
  };
}
