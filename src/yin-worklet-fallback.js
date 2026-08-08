// Development fallback used when the Emscripten-built YIN worklet is absent.
// It keeps the audio graph alive but intentionally reports no detected pitch.
class YinFallbackProcessor extends AudioWorkletProcessor {
  process() {
    this.port.postMessage({ silence: true });
    return true;
  }
}

registerProcessor("yin", YinFallbackProcessor);
