"""
Dependencies:
pip install vosk==0.3.42 sounddevice numpy webrtcvad
"""

import sys
import json
import argparse
import os
import queue
import time


def main():
    try:
        import sounddevice as sd
        import vosk
        import webrtcvad

        parser = argparse.ArgumentParser()
        parser.add_argument("--model", required=True, help="Path to Vosk model")
        parser.add_argument("--samplerate", type=int, default=16000, help="Sample rate")
        parser.add_argument(
            "--max_seconds", type=float, default=12.0, help="Max duration cap"
        )
        parser.add_argument(
            "--silence_ms", type=int, default=2200, help="Stop after ms silence"
        )
        parser.add_argument(
            "--vad_mode", type=int, default=3, help="0-3 aggressiveness"
        )
        parser.add_argument("--debug", action="store_true", help="Log debug info")
        parser.add_argument("--device", type=int, help="Input device ID (optional)")

        # Ignored args for backward compatibility during migration if extension sends --seconds
        parser.add_argument("--seconds", type=float, help="Ignored (legacy)")

        args = parser.parse_args()

        if not os.path.exists(args.model):
            raise FileNotFoundError(f"Model path '{args.model}' not found.")

        # Silence Vosk logs
        vosk.SetLogLevel(-1)

        vad = webrtcvad.Vad(args.vad_mode)
        model = vosk.Model(args.model)
        rec = vosk.KaldiRecognizer(model, args.samplerate)

        # Config
        frame_duration_ms = 30
        frame_samples = int(args.samplerate * frame_duration_ms / 1000)  # 480 @ 16k
        frame_bytes = frame_samples * 2  # int16 = 2 bytes

        q = queue.Queue()

        def callback(indata, frames, time_info, status):
            if status:
                sys.stderr.write(f"Audio Status: {status}\n")
            q.put(bytes(indata))

        speech_started = False
        non_speech_ms = 0

        # Debouncing: detecting consecutive speech frames to confirm speech
        # This prevents random noise clicks from resetting the silence timer
        consecutive_speech_ms = 0
        MIN_SPEECH_RUN_MS = 150  # 5 frames of 30ms

        # Start Time
        start_time = time.time()

        # Buffer for incoming raw bytes
        byte_buffer = b""

        if args.debug:
            sys.stderr.write(
                f"[DEBUG] Starting Stream. Max: {args.max_seconds}s, Silence: {args.silence_ms}ms, VAD: {args.vad_mode}\n"
            )

        with sd.RawInputStream(
            samplerate=args.samplerate,
            blocksize=frame_samples,
            channels=1,
            dtype="int16",
            callback=callback,
            device=args.device,
        ):
            while True:
                # Max duration check
                elapsed = time.time() - start_time
                if elapsed > args.max_seconds:
                    if args.debug:
                        sys.stderr.write(
                            f"[DEBUG] Max duration {args.max_seconds}s reached.\n"
                        )
                    break

                # Get data (blocking slightly to avoid busy loop)
                try:
                    data = q.get(timeout=0.1)
                except queue.Empty:
                    # Just verify max time again
                    continue

                byte_buffer += data

                # Process frames
                while len(byte_buffer) >= frame_bytes:
                    frame = byte_buffer[:frame_bytes]
                    byte_buffer = byte_buffer[frame_bytes:]

                    # VAD check
                    is_speech = vad.is_speech(frame, args.samplerate)

                    # Feed to Vosk
                    rec.AcceptWaveform(frame)

                    # Update status
                    if is_speech:
                        consecutive_speech_ms += frame_duration_ms

                        # Logic A: Detecting INITIAL speech start
                        # We are a bit more lenient on start, but strict on silence reset
                        if not speech_started:
                            # Use a smaller threshold for start? Or same?
                            if consecutive_speech_ms >= MIN_SPEECH_RUN_MS:
                                if args.debug:
                                    sys.stderr.write(
                                        "[DEBUG] Speech started (debounce).\n"
                                    )
                                speech_started = True
                                non_speech_ms = 0

                        # Logic B: Resetting Silence
                        # Only reset silence if we have had a run of speech
                        if speech_started:
                            if consecutive_speech_ms >= MIN_SPEECH_RUN_MS:
                                non_speech_ms = 0
                                # We stay in 'consecutive speech' state, so subsequent frames keep resetting non_speech_ms to 0
                    else:
                        consecutive_speech_ms = 0

                        if speech_started:
                            non_speech_ms += frame_duration_ms

                    if speech_started and non_speech_ms >= args.silence_ms:
                        if args.debug:
                            sys.stderr.write(
                                f"[DEBUG] Silence limit {args.silence_ms}ms reached. Stopping.\n"
                            )
                        # Break inner while, and set flag to break outer loop
                        raise StopIteration("Done")

    except StopIteration:
        pass  # Clean exit from loop via exception
    except Exception as e:
        res = {"text": "", "error": str(e)}
        print(json.dumps(res))
        sys.exit(1)

    # Process final result
    try:
        res = json.loads(rec.FinalResult())
        text = res.get("text", "")
        # Output ONLY JSON to stdout
        print(json.dumps({"text": text}))
    except Exception as e:
        print(json.dumps({"text": "", "error": f"Result parsing error: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
