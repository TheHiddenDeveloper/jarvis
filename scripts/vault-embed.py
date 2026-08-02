#!/usr/bin/env python3
"""Vault semantic index + search.

Indexes markdown notes in the Obsidian vault (~/Ideaverse) into an embedding index
using fastembed (ONNX, CPU). Chunks by markdown section; incremental by file mtime/size.

Usage:
  vault-embed.py index [--force]
  vault-embed.py search "query text" [--k 5] [--min-score 0.2]
  vault-embed.py status
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

VAULT_DIR = os.path.expanduser("~/Ideaverse")
INDEX_PATH = os.path.expanduser("~/jarvis/state/vault-index.json")
MODEL_NAME = "BAAI/bge-small-en-v1.5"
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
EXCLUDE_DIRS = {".obsidian", ".git", ".agents", ".trash"}
MIN_CHUNK_CHARS = 40

_dims = None


def load_model():
    from fastembed import TextEmbedding
    global _dims
    m = TextEmbedding(model_name=MODEL_NAME)
    _dims = len(list(m.embed(["probe"]))[0])
    return m


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def iter_md_files():
    for root, dirs, files in os.walk(VAULT_DIR):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for f in files:
            if f.endswith(".md"):
                yield os.path.join(root, f)


def chunk_markdown(text):
    """Split a note into (header, body) chunks on markdown headings."""
    if not text.strip():
        return []
    lines = text.splitlines()
    chunks = []
    current_header = ""
    current_body = []
    heading_re = re.compile(r"^#{1,4}\s+(.*)$")

    def flush():
        nonlocal current_header, current_body
        body = "\n".join(current_body).strip()
        if body and len(body) >= MIN_CHUNK_CHARS:
            header = current_header.strip()
            full = f"{header}\n\n{body}" if header else body
            chunks.append(full)
        current_body = []

    for ln in lines:
        m = heading_re.match(ln)
        if m:
            flush()
            current_header = m.group(1).strip()
        else:
            current_body.append(ln)
    flush()
    return chunks


def embed_texts(model, texts):
    return list(model.embed(texts, batch_size=64))


def load_index():
    if not os.path.exists(INDEX_PATH):
        return {"version": 1, "files": {}}
    try:
        return json.load(open(INDEX_PATH, encoding="utf-8"))
    except Exception:
        return {"version": 1, "files": {}}


def save_index(index):
    os.makedirs(os.path.dirname(INDEX_PATH), exist_ok=True)
    tmp = INDEX_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(index, f)
    os.replace(tmp, INDEX_PATH)


def build_index(force=False):
    model = load_model()
    index = load_index()
    files = index.setdefault("files", {})
    changed = 0
    total = 0

    for path in iter_md_files():
        total += 1
        try:
            st = os.stat(path)
            sig = f"{st.st_mtime_ns}:{st.st_size}"
        except OSError:
            continue
        rel = os.path.relpath(path, VAULT_DIR)
        prev = files.get(rel)
        if prev and prev.get("sig") == sig and not force:
            continue
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        chunks = chunk_markdown(text)
        if not chunks:
            files[rel] = {"sig": sig, "chunks": []}
            changed += 1
            continue
        vecs = embed_texts(model, chunks)
        files[rel] = {
            "sig": sig,
            "chunks": [{"text": c, "vec": [float(x) for x in v]} for c, v in zip(chunks, vecs)],
        }
        changed += 1

    index["updated"] = int(time.time())
    save_index(index)
    nchunks = sum(len(f.get("chunks", [])) for f in files.values())
    print(f"Indexed {total} notes ({changed} (re)embedded); {len(files)} in index, {nchunks} chunks -> {INDEX_PATH}")


def status():
    index = load_index()
    files = index.get("files", {})
    nchunks = sum(len(f.get("chunks", [])) for f in files.values())
    print(f"Index: {len(files)} notes, {nchunks} chunks. Built {time.strftime('%Y-%m-%d %H:%M', time.localtime(index.get('updated', 0)))}.")


def search(query, k=5, min_score=0.2):
    import numpy as np
    model = load_model()
    index = load_index()
    files = index.get("files", {})
    if not files:
        print("Index empty — run `vault-embed.py index` first.")
        return

    qvec = np.array(list(model.embed([QUERY_PREFIX + query]))[0], dtype=np.float32)
    qnorm = np.linalg.norm(qvec)
    results = []
    for rel, f in files.items():
        for ci, ch in enumerate(f.get("chunks", [])):
            v = np.array(ch["vec"], dtype=np.float32)
            score = float(np.dot(qvec, v) / (qnorm * np.linalg.norm(v) + 1e-9))
            if score >= min_score:
                results.append((score, rel, ch["text"]))
    results.sort(key=lambda x: -x[0])
    results = results[:k]

    if not results:
        print("No matches above score threshold.")
        return
    for i, (score, rel, text) in enumerate(results, 1):
        snippet = text.replace("\n", " ")[:180]
        print(f"[{i}] {score:.3f}  {rel}")
        print(f"    {snippet}")
        print()


def main():
    ap = argparse.ArgumentParser(description="Vault semantic index + search")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_idx = sub.add_parser("index")
    p_idx.add_argument("--force", action="store_true")
    sub.add_parser("status")
    p_srch = sub.add_parser("search")
    p_srch.add_argument("query")
    p_srch.add_argument("--k", type=int, default=5)
    p_srch.add_argument("--min-score", type=float, default=0.2)
    args = ap.parse_args()

    if args.cmd == "index":
        build_index(args.force)
    elif args.cmd == "status":
        status()
    elif args.cmd == "search":
        search(args.query, args.k, args.min_score)


if __name__ == "__main__":
    main()
