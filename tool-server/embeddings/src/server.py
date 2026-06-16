"""
Embeddings gRPC server — Phase 4
Tools: RLEC, Semantic-Diff, Context-Relevance Classifier, Semantic-Chunk Deduper, PDC, MCPR.

Run:
    python -m src.server
    EMBEDDINGS_GRPC_PORT=50052 python -m src.server

Proto generated:
    python -m grpc_tools.protoc -I../../proto --python_out=src/gen --grpc_python_out=src/gen ../../proto/embeddings.proto
"""

from __future__ import annotations

import os
import logging
import threading
from concurrent import futures
from pathlib import Path

import grpc
import numpy as np
from sentence_transformers import SentenceTransformer

# Generated proto stubs (generated on first start if missing)
_GEN_DIR = Path(__file__).parent / "gen"
_PROTO_DIR = Path(__file__).parent.parent.parent / "proto"


def _ensure_stubs() -> None:
    """Generate grpc stubs from proto if not already present."""
    if (_GEN_DIR / "embeddings_pb2_grpc.py").exists():
        return
    _GEN_DIR.mkdir(parents=True, exist_ok=True)
    (_GEN_DIR / "__init__.py").touch()
    from grpc_tools import protoc  # type: ignore
    result = protoc.main([
        "grpc_tools.protoc",
        f"-I{_PROTO_DIR}",
        f"--python_out={_GEN_DIR}",
        f"--grpc_python_out={_GEN_DIR}",
        str(_PROTO_DIR / "embeddings.proto"),
    ])
    if result != 0:
        raise RuntimeError("proto compilation failed")


_ensure_stubs()

import sys
sys.path.insert(0, str(_GEN_DIR))
import embeddings_pb2 as pb  # type: ignore
import embeddings_pb2_grpc as pb_grpc  # type: ignore

# ---------------------------------------------------------------------------
# Shared model (loaded once, used by all tools)
# ---------------------------------------------------------------------------

DEFAULT_MODEL = os.environ.get("EMBED_MODEL", "all-MiniLM-L6-v2")
_model_cache: dict[str, SentenceTransformer] = {}
_model_lock = threading.Lock()


def get_model(name: str = DEFAULT_MODEL) -> SentenceTransformer:
    with _model_lock:
        if name not in _model_cache:
            logging.info(f"Loading sentence-transformer model: {name}")
            _model_cache[name] = SentenceTransformer(name)
        return _model_cache[name]


# ---------------------------------------------------------------------------
# In-memory FAISS index store (namespace → (index, id_map, text_map))
# ---------------------------------------------------------------------------

import faiss  # type: ignore

_indices: dict[str, tuple[faiss.IndexFlatIP, list[str], dict[str, str]]] = {}
_indices_lock = threading.Lock()
_cache_dir = Path(os.environ.get("EMBED_CACHE_DIR", "./data/embeddings"))


def _index_path(namespace: str) -> Path:
    safe = namespace.replace("/", "_").replace(":", "_")
    return _cache_dir / safe


def _load_index(namespace: str) -> tuple[faiss.IndexFlatIP, list[str], dict[str, str]] | None:
    p = _index_path(namespace)
    idx_file = p / "index.faiss"
    meta_file = p / "meta.npz"
    if not idx_file.exists() or not meta_file.exists():
        return None
    index = faiss.read_index(str(idx_file))
    meta = np.load(str(meta_file), allow_pickle=True)
    id_list = list(meta["ids"])
    text_map = dict(zip(meta["ids"], meta["texts"]))
    return index, id_list, text_map


def _save_index(namespace: str, index: faiss.IndexFlatIP, id_list: list[str], text_map: dict[str, str]) -> None:
    p = _index_path(namespace)
    p.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(p / "index.faiss"))
    ids = np.array(id_list)
    texts = np.array([text_map.get(i, "") for i in id_list])
    np.savez(str(p / "meta.npz"), ids=ids, texts=texts)


def get_or_create_index(namespace: str, dim: int = 384) -> tuple[faiss.IndexFlatIP, list[str], dict[str, str]]:
    with _indices_lock:
        if namespace not in _indices:
            loaded = _load_index(namespace)
            if loaded:
                _indices[namespace] = loaded
            else:
                index = faiss.IndexFlatIP(dim)
                _indices[namespace] = (index, [], {})
        return _indices[namespace]


# ---------------------------------------------------------------------------
# gRPC service
# ---------------------------------------------------------------------------

class EmbeddingServicer(pb_grpc.EmbeddingServerServicer):

    def Embed(self, request: pb.EmbedRequest, context: grpc.ServicerContext) -> pb.EmbedResponse:
        model = get_model(request.model or DEFAULT_MODEL)
        texts = list(request.texts)
        if not texts:
            return pb.EmbedResponse()
        vectors = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        result = pb.EmbedResponse()
        for i, vec in enumerate(vectors):
            ev = pb.EmbedVector(id=str(i), values=vec.tolist())
            result.vectors.append(ev)
        return result

    def Search(self, request: pb.SearchRequest, context: grpc.ServicerContext) -> pb.SearchResponse:
        model = get_model(request.model or DEFAULT_MODEL)
        q_vec = model.encode([request.query], normalize_embeddings=True, show_progress_bar=False)
        q_vec = q_vec.astype("float32")

        index, id_list, text_map = get_or_create_index(request.namespace, q_vec.shape[1])
        k = min(request.top_k or 10, max(index.ntotal, 1))

        response = pb.SearchResponse()
        if index.ntotal == 0:
            return response

        scores, indices = index.search(q_vec, k)
        thresh = request.threshold or 0.0
        for score, idx in zip(scores[0], indices[0]):
            if idx < 0 or score < thresh:
                continue
            text_id = id_list[idx] if idx < len(id_list) else str(idx)
            response.results.append(pb.SearchResult(
                id=text_id,
                text=text_map.get(text_id, ""),
                score=float(score),
            ))
        return response

    def Cache(self, request: pb.CacheRequest, context: grpc.ServicerContext) -> pb.CacheResponse:
        if not request.entries:
            return pb.CacheResponse(indexed=0)
        model = get_model(DEFAULT_MODEL)
        texts = [e.text for e in request.entries]
        ids = [e.id for e in request.entries]
        vectors = model.encode(texts, normalize_embeddings=True, show_progress_bar=False).astype("float32")
        dim = vectors.shape[1]

        index, id_list, text_map = get_or_create_index(request.namespace, dim)
        with _indices_lock:
            index.add(vectors)
            id_list.extend(ids)
            for id_, text in zip(ids, texts):
                text_map[id_] = text
            _save_index(request.namespace, index, id_list, text_map)

        return pb.CacheResponse(indexed=len(ids))

    def Dedupe(self, request: pb.DedupeRequest, context: grpc.ServicerContext) -> pb.DedupeResponse:
        if not request.texts:
            return pb.DedupeResponse()
        model = get_model(request.model or DEFAULT_MODEL)
        threshold = request.threshold if request.threshold > 0 else 0.85
        vectors = model.encode(list(request.texts), normalize_embeddings=True, show_progress_bar=False)

        cluster_ids = [-1] * len(vectors)
        representatives: list[str] = []
        rep_vectors: list[np.ndarray] = []

        for i, vec in enumerate(vectors):
            matched = -1
            for ci, rv in enumerate(rep_vectors):
                sim = float(np.dot(vec, rv))
                if sim >= threshold:
                    matched = ci
                    break
            if matched == -1:
                matched = len(representatives)
                representatives.append(request.texts[i])
                rep_vectors.append(vec)
            cluster_ids[i] = matched

        return pb.DedupeResponse(
            representatives=representatives,
            cluster_ids=cluster_ids,
        )

    def Rank(self, request: pb.RelevanceRequest, context: grpc.ServicerContext) -> pb.RelevanceResponse:
        if not request.candidates:
            return pb.RelevanceResponse()
        model = get_model(request.model or DEFAULT_MODEL)
        all_texts = [request.query] + list(request.candidates)
        vectors = model.encode(all_texts, normalize_embeddings=True, show_progress_bar=False)
        q_vec = vectors[0]
        c_vecs = vectors[1:]
        scores = np.dot(c_vecs, q_vec)

        top_k = request.top_k if request.top_k > 0 else len(request.candidates)
        ranked_idx = np.argsort(scores)[::-1][:top_k]

        response = pb.RelevanceResponse()
        for ri in ranked_idx:
            response.items.append(pb.RankedItem(
                index=int(ri),
                text=request.candidates[ri],
                score=float(scores[ri]),
            ))
        return response


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def serve() -> None:
    port = int(os.environ.get("EMBEDDINGS_GRPC_PORT", "50052"))
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    pb_grpc.add_EmbeddingServerServicer_to_server(EmbeddingServicer(), server)
    server.add_insecure_port(f"127.0.0.1:{port}")
    logging.basicConfig(level=logging.INFO)
    logging.info(f"[embeddings] gRPC listening on 127.0.0.1:{port}")
    # Pre-load default model at startup (avoids cold start on first tool call)
    get_model(DEFAULT_MODEL)
    server.start()
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
