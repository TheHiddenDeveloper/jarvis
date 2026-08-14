#!/usr/bin/env python3
"""Jarvis Knowledge Graph — graph-indexed recall for the Jarvis vault.

Builds a weighted knowledge graph over every note in ~/jarvis/vault and
~/jarvis/memory, then answers queries with graph-aware recall:

  1. embed the query (bge-small-en-v1.5, CPU, fastembed)
  2. seed = top-k nodes by cosine similarity
  3. Personalized PageRank / random walk with restart over the graph
     (r = (1-a)*s + a*P*r, a = 0.85) to spread activation through relations
  4. rank nodes by hybrid score = similarity + beta * pagerank
  5. reconstruct the traversal path from each result back to the seeds

Indexing is incremental (mtime:size signatures), like vault-embed.py.

Usage:
  jarvis-kg.py index [--force]
  jarvis-kg.py search "query" [--k 5] [--alpha 0.85] [--beta 1.0] [--seeds 3]
  jarvis-kg.py status
  jarvis-kg.py graph --node <slug>   # print a node + its direct neighbors
"""
import argparse
import hashlib
import json
import os
import re
import time

VAULT_DIR = os.path.expanduser("~/jarvis/vault")
MEMORY_DIR = os.path.expanduser("~/jarvis/memory")
INDEX_PATH = os.path.expanduser("~/jarvis/state/jarvis-kg.json")
MODEL_NAME = "BAAI/bge-small-en-v1.5"
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
EXCLUDE_DIRS = {".obsidian", ".git", ".agents", ".trash"}
MIN_CHUNK_CHARS = 30
SEM_EDGE_MIN = 0.45           # min cosine for a semantic edge
SEM_TOP_K = 5                 # max semantic neighbors per node
REF_WEIGHT_BASE = 1.0
REF_WEIGHT_LOG = 0.5
_dims = None


# ---------------------------------------------------------------- model/embed
def load_model():
    from fastembed import TextEmbedding
    global _dims
    m = TextEmbedding(model_name=MODEL_NAME)
    _dims = len(list(m.embed(["probe"]))[0])
    return m


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def embed_texts(model, texts):
    return list(model.embed(texts, batch_size=64))


# ------------------------------------------------------------------- indexing
def iter_md_files():
    roots = [(VAULT_DIR, "vault"), (MEMORY_DIR, "memory")]
    for root, prefix in roots:
        if not os.path.isdir(root):
            continue
        for r, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for f in files:
                if f.endswith(".md"):
                    yield os.path.join(r, f), prefix


def note_slug(rel):
    """kebab-case identifier for a note, used as node key and for ref matching."""
    base = rel[:-3] if rel.endswith(".md") else rel
    return base.lower()


def chunk_markdown(text):
    if not text.strip():
        return []
    lines = text.splitlines()
    chunks, header, body = [], "", []
    heading_re = re.compile(r"^#{1,4}\s+(.*)$")

    def flush():
        nonlocal header, body
        b = "\n".join(body).strip()
        if b and len(b) >= MIN_CHUNK_CHARS:
            chunks.append((f"{header}\n\n{b}" if header else b).strip())
        body = []

    for ln in lines:
        m = heading_re.match(ln)
        if m:
            flush()
            header = m.group(1).strip()
        else:
            body.append(ln)
    flush()
    return chunks


def extract_relations(text):
    """Explicit relations: Obsidian [[wikilinks]] and `backtick` identifiers."""
    links = set()
    ticks = set()
    for m in re.finditer(r"\[\[([^\]]+)\]\]", text):
        target = m.group(1).split("|")[0].strip().lower()
        if target:
            links.add(target)
    for m in re.finditer(r"`([a-z0-9][a-z0-9-]{1,60})`", text):
        ticks.add(m.group(1).lower())
    return links, ticks


def load_index():
    if not os.path.exists(INDEX_PATH):
        return {"version": 2, "nodes": {}, "edges": {}, "updated": 0}
    try:
        return json.load(open(INDEX_PATH, encoding="utf-8"))
    except Exception:
        return {"version": 2, "nodes": {}, "edges": {}, "updated": 0}


def save_index(index):
    os.makedirs(os.path.dirname(INDEX_PATH), exist_ok=True)
    tmp = INDEX_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(index, f)
    os.replace(tmp, INDEX_PATH)


def mean_pool(vecs):
    import numpy as np
    if not vecs:
        return None
    v = np.mean(np.stack(vecs), axis=0)
    n = float(np.linalg.norm(v))
    return (v / n).tolist() if n > 0 else None


def build_index(force=False):
    model = load_model()
    index = load_index()
    nodes = index.setdefault("nodes", {})
    changed = total = 0

    for path, prefix in iter_md_files():
        total += 1
        try:
            st = os.stat(path)
            sig = f"{st.st_mtime_ns}:{st.st_size}"
        except OSError:
            continue
        rel = os.path.join("vault", os.path.relpath(path, VAULT_DIR)) if prefix == "vault" else os.path.join("memory", os.path.basename(path))
        slug = note_slug(rel)
        prev = nodes.get(slug)
        if prev and prev.get("sig") == sig and not force:
            continue
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        chunks = chunk_markdown(text)
        vecs = embed_texts(model, chunks) if chunks else []
        links, ticks = extract_relations(text)
        nodes[slug] = {
            "sig": sig,
            "title": os.path.basename(path)[:-3],
            "path": rel,
            "mtime": int(st.st_mtime),
            "links": sorted(links),
            "ticks": sorted(ticks),
            "vec": mean_pool(vecs),
        }
        changed += 1

    index["updated"] = int(time.time())
    # rebuild edge set from current nodes
    edges = {}
    slugs = list(nodes.keys())
    for slug, n in nodes.items():
        edges.setdefault(slug, {})
        for lk in n.get("links", []):
            if lk in nodes and lk != slug:
                edges[slug][lk] = edges[slug].get(lk, 0) + REF_WEIGHT_BASE + REF_WEIGHT_LOG
        # backtick ids that name another node -> strong ref
        for tk in n.get("ticks", []):
            if tk in nodes and tk != slug:
                edges[slug][tk] = edges[slug].get(tk, 0) + REF_WEIGHT_BASE + REF_WEIGHT_LOG
        # ticks shared with other nodes -> co-occurrence edges
        for other, on in nodes.items():
            if other == slug:
                continue
            shared = set(n.get("ticks", [])) & set(on.get("ticks", []))
            if shared:
                edges[slug][other] = edges[slug].get(other, 0) + min(len(shared), 3) * 0.4
    # semantic edges (undirected, top-k per node)
    import numpy as np
    order = [s for s in slugs if nodes[s].get("vec")]
    vecs = np.array([nodes[s]["vec"] for s in order], dtype=np.float32)
    if len(order) > 1:
        sims = vecs @ vecs.T
        np.fill_diagonal(sims, -1)
        for i, s in enumerate(order):
            top = np.argsort(-sims[i])[:SEM_TOP_K]
            for j in top:
                c = float(sims[i, j])
                if c >= SEM_EDGE_MIN and j != i:
                    o = order[j]
                    edges[s][o] = max(edges[s].get(o, 0), c)
    index["edges"] = edges
    save_index(index)
    nedges = sum(len(v) for v in edges.values())
    print(f"KG: {len(nodes)} nodes, {nedges} directed edges ({changed} (re)built) -> {INDEX_PATH}")


# ------------------------------------------------------------------------ recall
def load():
    return load_index()


def search(query, k=5, alpha=0.85, beta=1.0, seeds_n=3):
    import numpy as np
    model = load_model()
    index = load()
    nodes = index.get("nodes", {})
    edges = index.get("edges", {})
    order = [s for s in nodes if nodes[s].get("vec")]
    if not order:
        print("KG empty — run `jarvis-kg.py index` first.")
        return
    V = np.array([nodes[s]["vec"] for s in order], dtype=np.float32)
    qv = np.array(list(model.embed([QUERY_PREFIX + query]))[0], dtype=np.float32)
    qn = float(np.linalg.norm(qv))
    sims = V @ (qv / (qn + 1e-9))
    idx = np.argsort(-sims)
    seeds = [order[i] for i in idx[:seeds_n]]
    seed_scores = {order[i]: float(sims[i]) for i in idx[:seeds_n]}

    # build row-stochastic transition matrix
    n = len(order)
    P = np.zeros((n, n), dtype=np.float64)
    for i, s in enumerate(order):
        nbr = edges.get(s, {})
        for t, w in nbr.items():
            if t in nodes and nodes[t].get("vec"):
                j = order.index(t)
                P[i, j] += float(w)
        row = P[i]
        s_ = float(row.sum())
        if s_ > 0:
            P[i] = row / s_
        else:
            P[i, i] = 1.0  # sink

    s0 = np.zeros(n, dtype=np.float64)
    for s in seeds:
        s0[order.index(s)] = max(seed_scores[s], 0.0)
    if s0.sum() == 0:
        s0 = np.ones(n) / n
    else:
        s0 = s0 / s0.sum()

    r = s0.copy()
    a = float(alpha)
    for _ in range(60):
        rn = (1 - a) * s0 + a * (r @ P)
        if float(np.abs(rn - r).max()) < 1e-7:
            r = rn
            break
        r = rn

    # hybrid score + sort
    scored = []
    for i, s in enumerate(order):
        scored.append((float(sims[i]) + beta * float(r[i]), float(sims[i]), float(r[i]), s))
    scored.sort(key=lambda x: -x[0])
    scored = scored[:k]

    def path_to_seed(tgt):
        """Greedy walk: from tgt, hop to the neighbor carrying the most rank
        probability, until we reach a seed. Bounds the hop count to keep it fast."""
        cur = tgt
        trail = [tgt]
        guard = 0
        while cur not in seeds and guard < 12:
            guard += 1
            nbr = edges.get(cur, {})
            best, bestw = None, 0.0
            for t, w in nbr.items():
                if t in nodes and nodes[t].get("vec") and float(w) > bestw:
                    best, bestw = t, float(w)
            if not best or best in trail:
                break
            trail.append(best)
            cur = best
        return trail

    for i, (score, sim, pr, s) in enumerate(scored, 1):
        n = nodes[s]
        print(f"[{i}] score={score:.3f} sim={sim:.3f} pr={pr:.3f}  {n['path']}")
        trail = path_to_seed(s)
        if len(trail) > 1:
            print(f"    path: {' -> '.join(trail)}")
    print(f"\nseeds: {', '.join(seeds)}")


def node_view(slug):
    index = load()
    nodes = index.get("nodes", {})
    edges = index.get("edges", {})
    if slug not in nodes:
        print(f"no node {slug}")
        return
    n = nodes[slug]
    print(f"{slug}  ({n['path']})  mtime={n.get('mtime')}")
    out = sorted((edges.get(slug, {}) or {}).items(), key=lambda kv: -kv[1])
    for t, w in out[:15]:
        print(f"  -> {t}  (w={w:.2f})")
    inc = [(s, e) for s, e in edges.items() if slug in e]
    inc.sort(key=lambda kv: -kv[1][slug])
    for s, e in inc[:15]:
        print(f"  <- {s}  (w={e[slug]:.2f})")


def status():
    index = load()
    nodes = index.get("nodes", {})
    edges = index.get("edges", {})
    nedges = sum(len(v) for v in edges.values())
    ts = time.strftime("%Y-%m-%d %H:%M", time.localtime(index.get("updated", 0)))
    print(f"KG: {len(nodes)} nodes, {nedges} directed edges. Built {ts}.")


def main():
    ap = argparse.ArgumentParser(description="Jarvis knowledge graph")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_idx = sub.add_parser("index")
    p_idx.add_argument("--force", action="store_true")
    sub.add_parser("status")
    p_srch = sub.add_parser("search")
    p_srch.add_argument("query")
    p_srch.add_argument("--k", type=int, default=5)
    p_srch.add_argument("--alpha", type=float, default=0.85)
    p_srch.add_argument("--beta", type=float, default=1.0)
    p_srch.add_argument("--seeds", type=int, default=3)
    p_g = sub.add_parser("graph")
    p_g.add_argument("--node")
    args = ap.parse_args()

    if args.cmd == "index":
        build_index(args.force)
    elif args.cmd == "status":
        status()
    elif args.cmd == "search":
        search(args.query, args.k, args.alpha, args.beta, args.seeds)
    elif args.cmd == "graph":
        node_view(args.node)


if __name__ == "__main__":
    main()
