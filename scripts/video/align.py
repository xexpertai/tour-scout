"""Word timings for the story captions: transcribes each voiced line locally (mlx-whisper, small.en) and
maps the recognised words onto the script words (same count required; hyphenated words are merged).
Usage: uv run --python 3.12 --with mlx-whisper python scripts/video/align.py <build_dir> video/story.json"""
import json, sys, glob, os, re
import mlx_whisper
S=sys.argv[1]; story=json.load(open(sys.argv[2])); out={}
for ln in story["lines"]:
    r=mlx_whisper.transcribe(f"{S}/audio-trim/{ln['id']}.wav", path_or_hf_repo="mlx-community/whisper-small.en-mlx", word_timestamps=True, language="en")
    ws=[(w["word"].strip(), round(w["start"],3), round(w["end"],3)) for s in r["segments"] for w in s["words"]]
    script=ln["text"].split()
    m=[]
    for w in ws:  # whisper splits hyphenated words ("five -city"): merge them back
        if m and w[0].startswith("-"): m[-1]=(m[-1][0]+w[0], m[-1][1], w[2])
        else: m.append(w)
    ws=m
    ok=len(ws)==len(script)
    out[ln["id"]]={"words":[{"w":script[i],"s":ws[i][1],"e":ws[i][2]} for i in range(len(script))] if ok else None, "heard":" ".join(w for w,_,_ in ws)}
    print(ln["id"], "OK" if ok else "MISMATCH", len(ws), len(script), "|", " ".join(w for w,_,_ in ws))
json.dump(out, open(f"{S}/words.json","w"), indent=1)
