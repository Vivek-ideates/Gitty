"""
Dependencies:
pip install vosk==0.3.42 sounddevice numpy
"""

import sys
import json
import argparse
import os

def main():
    # Wrap everything in try-except to ensure JSON error output
    try:
        import sounddevice as sd
        import vosk

        parser = argparse.ArgumentParser()
        parser.add_argument("--model", required=True, help="Path to Vosk model")
        parser.add_argument("--seconds", type=float, default=5, help="Recording duration in seconds")
        parser.add_argument("--samplerate", type=int, default=16000, help="Sample rate")
        args = parser.parse_args()

        if not os.path.exists(args.model):
            raise FileNotFoundError(f"Model path '{args.model}' not found.")

        # Silence Vosk logs
        vosk.SetLogLevel(-1)

        model = vosk.Model(args.model)
        rec = vosk.KaldiRecognizer(model, args.samplerate)

        # Record audio
        # blocking recording
        recording = sd.rec(int(args.seconds * args.samplerate), 
                           samplerate=args.samplerate, 
                           channels=1, 
                           dtype='int16')
        sd.wait()

        # Feed to recognizer
        if rec.AcceptWaveform(recording.tobytes()):
            # If the whole audio was accepted as a full utterance
            pass 
        
        # Get final result
        res = rec.FinalResult()
        data = json.loads(res)
        
        # Output exactly one line of JSON
        print(json.dumps({"text": data.get("text", "")}))

    except Exception as e:
        print(json.dumps({"text": "", "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
