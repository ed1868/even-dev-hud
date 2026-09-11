/**
 * Ring buffer for PCM audio from the glasses mic.
 *
 * Accumulates audio events and retains the last N seconds. When the user
 * long-presses, the buffer freezes and produces a WAV blob for the shim.
 *
 * The Even SDK sends PCM frames via `audioEvent` at a high rate. This buffer
 * absorbs them and only allocates on freeze — the hot path is a push into a
 * circular array.
 *
 * PCM format from the SDK: 16-bit signed, mono, 16 kHz. The WAV header
 * wraps the raw samples so Whisper can consume them directly.
 */

/** How many seconds of audio to retain. */
const RETAIN_SECONDS = 30;
/** Sample rate from the Even SDK's glasses mic. */
const SAMPLE_RATE = 16_000;
/** Bytes per second: 16-bit mono = 2 bytes/sample × 16000 samples/sec. */
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** Maximum buffer size in bytes. */
const MAX_BYTES = RETAIN_SECONDS * BYTES_PER_SECOND;

export class AudioRingBuffer {
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;

  /** Push a PCM chunk from an audio event. */
  push(pcm: Uint8Array): void {
    this.chunks.push(pcm);
    this.totalBytes += pcm.byteLength;
    this.trim();
  }

  /** Evict old chunks to stay under the retention window. */
  private trim(): void {
    while (this.totalBytes > MAX_BYTES && this.chunks.length > 0) {
      const evicted = this.chunks.shift()!;
      this.totalBytes -= evicted.byteLength;
    }
  }

  /** How many seconds of audio are buffered. */
  get seconds(): number {
    return this.totalBytes / BYTES_PER_SECOND;
  }

  /** True if we have at least 1 second of audio. */
  get hasAudio(): boolean {
    return this.totalBytes >= BYTES_PER_SECOND;
  }

  /** Clear the buffer. */
  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }

  /**
   * Freeze the buffer and return the contents as a WAV-encoded base64 string.
   * Does NOT clear the buffer — call `clear()` separately if desired.
   */
  toWavBase64(): string {
    // Concatenate all chunks into a single PCM buffer
    const pcm = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Build WAV header (44 bytes)
    const wav = new ArrayBuffer(44 + pcm.byteLength);
    const view = new DataView(wav);

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + pcm.byteLength, true);
    writeString(view, 8, 'WAVE');

    // fmt chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // chunk size
    view.setUint16(20, 1, true);            // PCM format
    view.setUint16(22, 1, true);            // mono
    view.setUint32(24, SAMPLE_RATE, true);  // sample rate
    view.setUint32(28, BYTES_PER_SECOND, true); // byte rate
    view.setUint16(32, 2, true);            // block align
    view.setUint16(34, 16, true);           // bits per sample

    // data chunk
    writeString(view, 36, 'data');
    view.setUint32(40, pcm.byteLength, true);

    // Copy PCM data
    new Uint8Array(wav).set(pcm, 44);

    // Encode to base64
    return uint8ToBase64(new Uint8Array(wav));
  }
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Encode Uint8Array to base64, handling large buffers. */
function uint8ToBase64(bytes: Uint8Array): string {
  // btoa works on strings; convert in chunks to avoid call stack limits
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, bytes.byteLength);
    const slice = bytes.subarray(i, end);
    for (let j = 0; j < slice.length; j++) {
      binary += String.fromCharCode(slice[j]!);
    }
  }
  return btoa(binary);
}
